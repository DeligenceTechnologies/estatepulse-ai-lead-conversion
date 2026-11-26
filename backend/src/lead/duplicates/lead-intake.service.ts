import { Injectable } from '@nestjs/common';
import { LeadStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { isSuppressed } from '@/lead/contact-suppression';
import { type Actor, LeadStateService } from '@/lead/lead-state.service';
import { FILLABLE_FIELDS, type FillableValues, fillBlanks, mergeObjects } from './merge-rules';
import { withSurvivors } from './merged-redirect';

type Tx = Prisma.TransactionClient;

export type SubmissionChannel = 'webhook' | 'manual' | 'import' | 'crm' | 'sms';

/** One arrival of a person from a source, before it is known whether they are already a lead. */
export interface Submission {
  orgId: string;
  leadSourceId: string | null;
  /** For the lead's history line ("Returned via Website form"). */
  sourceName?: string | null;
  channel: SubmissionChannel;
  /** From identity.ts: E.164 / lowercased, or null. */
  normalizedPhone: string | null;
  normalizedEmail: string | null;
  values: FillableValues;
  customFields?: Record<string, unknown>;
  submittedAt: Date;
  actor?: Actor;
}

export type ExactMatch =
  | { kind: 'none' }
  | { kind: 'match'; leadId: string; by: 'phone' | 'email' }
  /** The phone is one lead's and the email another's (or the email's lead has another phone): a person decides. */
  | { kind: 'conflict'; leadIds: string[] };

export interface IntakeResult {
  leadId: string;
  /** Set when the submission was attached to a lead that already existed. */
  matchedBy: 'phone' | 'email' | null;
  /** Leads the new one may be the same person as; a DuplicateCandidate is opened for each. */
  conflictWith: string[];
}

/** Statuses a person can come back from by filling in another form; someone should look. */
const RETURNING_FROM: LeadStatus[] = [LeadStatus.not_interested, LeadStatus.unresponsive, LeadStatus.closed];
export const returnedReason = (source: string) => `Came back via ${source} after being closed out — review before contacting`;

interface KeyedLead {
  id: string;
  normalizedPhone: string | null;
  normalizedEmail: string | null;
}

/**
 * Which of `leads` (newest first, none merged) a phone/email belongs to. The phone decides first
 * (it is what texts and calls are routed on); an email match only counts when it does not point at
 * someone with a different phone. Several leads already sharing the key (old duplicates) resolve to
 * the newest, the same lead an inbound text goes to. Pure: the import engine runs it over leads it
 * has already loaded.
 */
export function decideMatch(phone: string | null, email: string | null, leads: KeyedLead[]): ExactMatch {
  const byPhone = phone ? leads.filter((l) => l.normalizedPhone === phone) : [];
  const byEmail = email ? leads.filter((l) => l.normalizedEmail === email) : [];
  if (byPhone.length) {
    const both = byPhone.find((l) => email && l.normalizedEmail === email);
    if (both) return { kind: 'match', leadId: both.id, by: 'phone' };
    const elsewhere = byEmail.filter((l) => !byPhone.some((p) => p.id === l.id));
    if (elsewhere.length) return { kind: 'conflict', leadIds: [byPhone[0].id, ...elsewhere.map((l) => l.id)] };
    return { kind: 'match', leadId: byPhone[0].id, by: 'phone' };
  }
  if (byEmail.length) {
    const compatible = byEmail.find((l) => !phone || !l.normalizedPhone);
    if (compatible) return { kind: 'match', leadId: compatible.id, by: 'email' };
    return { kind: 'conflict', leadIds: byEmail.map((l) => l.id) };
  }
  return { kind: 'none' };
}

const FILL_SELECT = Object.fromEntries(FILLABLE_FIELDS.map((f) => [f, true])) as Record<(typeof FILLABLE_FIELDS)[number], true>;

/**
 * One lead per person. Every way a lead is created (webhook, form poll, import, CRM sync, manual
 * entry) asks here first: a submission whose phone or email is already a lead's is attached to that
 * lead — its source and values kept as a LeadSubmission, blanks filled, nothing overwritten — and no
 * new lead is made. Matching is exact on the normalized keys only; anything looser is a suggestion
 * (DuplicateScannerService), never an automatic attach.
 */
@Injectable()
export class LeadIntakeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly state: LeadStateService,
  ) {}

  /**
   * Attaches `submission` to the lead it matches, or runs `create` (inside the same transaction and
   * under the same locks, so two deliveries of one person at once still make one lead) and records
   * the new lead's original submission. `create` gets the conflicting lead ids, to flag the new lead.
   */
  async intake(submission: Submission, create: (tx: Tx, conflictWith: string[]) => Promise<string>): Promise<IntakeResult> {
    return this.prisma.$transaction((tx) => this.intakeIn(tx, submission, create), { timeout: 20_000 });
  }

  /** As intake, inside a transaction the caller already holds. */
  async intakeIn(tx: Tx, submission: Submission, create: (tx: Tx, conflictWith: string[]) => Promise<string>): Promise<IntakeResult> {
    await this.lock(tx, submission.orgId, submission.normalizedPhone, submission.normalizedEmail);
    const match = await this.findExact(tx, submission.orgId, submission.normalizedPhone, submission.normalizedEmail);
    if (match.kind === 'match') {
      await this.attach(tx, match.leadId, match.by, submission);
      return { leadId: match.leadId, matchedBy: match.by, conflictWith: [] };
    }
    const conflictWith = match.kind === 'conflict' ? match.leadIds : [];
    const leadId = await create(tx, conflictWith);
    await this.recordOriginal(tx, leadId, submission);
    if (conflictWith.length) await this.openCandidates(tx, submission.orgId, leadId, conflictWith, ['Same phone or email as another lead']);
    return { leadId, matchedBy: null, conflictWith };
  }

  /** Serializes everyone creating a lead for the same phone or email in the org, for this transaction. */
  async lock(tx: Tx, orgId: string, phone: string | null, email: string | null): Promise<void> {
    const keys = [phone && `lead:${orgId}:p:${phone}`, email && `lead:${orgId}:e:${email}`].filter((k): k is string => !!k).sort();
    for (const key of keys) await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${key}))`;
  }

  /** The lead this phone/email belongs to (decideMatch over the org's unmerged leads). */
  async findExact(db: Tx | PrismaService, orgId: string, phone: string | null, email: string | null): Promise<ExactMatch> {
    if (!phone && !email) return { kind: 'none' };
    const found = await db.lead.findMany({
      where: {
        orgId,
        OR: [...(phone ? [{ normalizedPhone: phone }] : []), ...(email ? [{ normalizedEmail: email }] : [])],
      },
      // Live leads first: a merged one only stands in (as its survivor) for a key no live lead has.
      orderBy: [{ mergedAt: { sort: 'desc', nulls: 'first' } }, { createdAt: 'desc' }],
      select: { id: true, normalizedPhone: true, normalizedEmail: true, mergedIntoId: true },
      take: 20,
    });
    return decideMatch(phone, email, await withSurvivors(db, found));
  }

  /** Folds a submission into an existing lead: blanks filled, the source kept, the lead's history told. */
  async attach(tx: Tx, leadId: string, by: 'phone' | 'email', s: Submission): Promise<void> {
    const lead = await tx.lead.findUniqueOrThrow({
      where: { id: leadId },
      select: { ...FILL_SELECT, status: true, customFields: true, reviewReasons: true, dncStatus: true, lastSubmissionAt: true },
    });
    const filled = fillBlanks(lead, s.values);
    const data: Prisma.LeadUncheckedUpdateInput = { ...(filled as Prisma.LeadUncheckedUpdateInput) };

    if (filled.phone) {
      data.normalizedPhone = s.normalizedPhone;
      data.phoneValid = Boolean(s.normalizedPhone);
      // A number that opted out stays out, whichever lead it arrives on.
      if (!lead.dncStatus && s.normalizedPhone && (await isSuppressed(tx, s.orgId, s.normalizedPhone))) {
        data.dncStatus = true;
        data.automationPaused = true;
      }
    }
    if (filled.email) {
      data.normalizedEmail = s.normalizedEmail;
      data.emailValid = Boolean(s.normalizedEmail);
    }
    if (s.customFields && Object.keys(s.customFields).length) {
      data.customFields = mergeObjects(lead.customFields, s.customFields) as Prisma.InputJsonValue;
    }
    const source = s.sourceName ?? channelLabel(s.channel);
    if (RETURNING_FROM.includes(lead.status)) {
      const reason = returnedReason(source);
      if (!lead.reviewReasons.includes(reason)) {
        data.reviewReasons = [...lead.reviewReasons, reason];
        data.needsReview = true;
      }
    }
    data.submissionCount = { increment: 1 };
    if (!lead.lastSubmissionAt || s.submittedAt > lead.lastSubmissionAt) data.lastSubmissionAt = s.submittedAt;
    await tx.lead.update({ where: { id: leadId }, data });

    await tx.leadSubmission.create({ data: this.submissionRow(leadId, s, { matchedBy: by, isOriginal: false }) });
    await this.state.record(
      {
        orgId: s.orgId,
        leadId,
        type: 'resubmitted',
        source: s.channel,
        actor: s.actor,
        reason: `Submitted again via ${source} (matched by ${by})`,
        payload: { leadSourceId: s.leadSourceId, matchedBy: by, filled: Object.keys(filled) },
      },
      tx,
    );
  }

  async recordOriginal(tx: Tx, leadId: string, s: Submission): Promise<void> {
    await tx.leadSubmission.create({ data: this.submissionRow(leadId, s, { matchedBy: null, isOriginal: true }) });
  }

  /** Opens (or keeps open) a review pair for each lead; a dismissed pair stays dismissed. */
  async openCandidates(db: Tx | PrismaService, orgId: string, leadId: string, others: string[], reasons: string[], score = 100): Promise<void> {
    for (const other of others) {
      if (other === leadId) continue;
      const [leadAId, leadBId] = leadId < other ? [leadId, other] : [other, leadId];
      await db.duplicateCandidate.upsert({
        where: { leadAId_leadBId: { leadAId, leadBId } },
        create: { orgId, leadAId, leadBId, score, reasons },
        update: {},
      });
    }
  }

  private submissionRow(
    leadId: string,
    s: Submission,
    extra: { matchedBy: 'phone' | 'email' | null; isOriginal: boolean },
  ): Prisma.LeadSubmissionUncheckedCreateInput {
    const values = Object.fromEntries(
      Object.entries({ ...s.values, ...(s.customFields ?? {}) }).filter(([, v]) => v !== null && v !== undefined && v !== ''),
    );
    return {
      orgId: s.orgId,
      leadId,
      leadSourceId: s.leadSourceId,
      channel: s.channel,
      matchedBy: extra.matchedBy,
      isOriginal: extra.isOriginal,
      values: JSON.parse(JSON.stringify(values)) as Prisma.InputJsonValue,
      submittedAt: s.submittedAt,
    };
  }
}

const channelLabel = (c: SubmissionChannel) =>
  ({ webhook: 'a form', manual: 'manual entry', import: 'an import', crm: 'the CRM', sms: 'a text' })[c];
