import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import parsePhoneNumberFromString from 'libphonenumber-js';
import type { AuthContext } from '@/auth/auth.types';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { startsDoNotContact } from './contact-suppression';
import type { UpdateLeadDto } from './dto/update-lead.dto';
import { OUTSIDE_IMPORT_REVIEW, visibleLeads } from './lead-scope';
import { LeadStateService } from './lead-state.service';
import { LeadTimezoneService } from './lead-timezone.service';
import { PHONE_CORRECTED_REASON, isPhoneReason } from './review-reasons';

/** Why an edit made the lead do-not-contact; kept with its review reasons so the next person sees it. */
export const EDIT_DNC_REASON = 'The new phone or email asked not to be contacted before: the lead is now do-not-contact';

const EDITABLE = {
  firstName: true,
  lastName: true,
  phone: true,
  email: true,
  location: true,
  timeline: true,
  minBudget: true,
  maxBudget: true,
  bedrooms: true,
  financingStatus: true,
  motivation: true,
} as const;

const CURRENT = {
  ...EDITABLE,
  normalizedPhone: true,
  normalizedEmail: true,
  phoneValid: true,
  dncStatus: true,
  automationPaused: true,
  needsReview: true,
  reviewReasons: true,
} as const satisfies Prisma.LeadSelect;

type Current = Prisma.LeadGetPayload<{ select: typeof CURRENT }>;
type Field = keyof typeof EDITABLE;
type Value = string | number | null;

type Changes = Partial<Record<Field, [Value, Value]>>;

/** The audit trail and the timeline name the form's field, not the column. */
const labelled = (changed: Changes): Record<string, [Value, Value]> =>
  Object.fromEntries(Object.entries(changed).map(([field, pair]) => [field === 'motivation' ? 'notes' : field, pair]));

const plain = (v: Current[Field]): Value => (v instanceof Prisma.Decimal ? v.toNumber() : (v ?? null));

export interface LeadEditResult {
  /** The fields that changed, by name, as [before, after]. Empty when the edit matched what was stored. */
  changed: Record<string, [Value, Value]>;
  /** True when the new phone or email belongs to someone who opted out: the lead was made do-not-contact. */
  becameDoNotContact: boolean;
}

/**
 * A person correcting a lead's own details: name, contact, what they are looking for. Not its
 * status, consent, do-not-contact flag, assignment or time zone, which have their own routes.
 *
 * A changed phone is parsed like a manual lead's and re-checked against the do-not-contact list,
 * and so is a changed email; an edit can make a lead do-not-contact, never the reverse. A lead
 * still in import review is not edited here: an import refresh would overwrite it, and the
 * review screen is where it is corrected.
 */
@Injectable()
export class LeadEditService {
  private readonly logger = new Logger(LeadEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly audit: AuditService,
    private readonly events: EventsBus,
    private readonly state: LeadStateService,
    private readonly timezones: LeadTimezoneService,
  ) {}

  async update(auth: AuthContext, leadId: string, input: UpdateLeadDto): Promise<LeadEditResult> {
    const { organizationId: orgId, userId } = auth;

    const result = await this.prisma.$transaction(async (tx) => {
      // Only a lead the user may see: an assigned-only agent edits their own leads alone.
      const lead = await tx.lead.findFirst({
        where: { id: leadId, ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW },
        select: CURRENT,
      });
      if (!lead) throw new AppError('NOT_FOUND', 'No such lead, or it is still waiting in Import Review.');

      const next = this.desired(lead, input);
      const changed = this.diff(lead, next);
      if (Object.keys(changed).length === 0) return { changed: {}, becameDoNotContact: false, phoneChanged: false };

      if (!next.phone && !next.email) {
        throw new AppError('VALIDATION_ERROR', 'A lead needs a phone number or an email address.');
      }
      if (next.minBudget !== null && next.maxBudget !== null && next.minBudget > next.maxBudget) {
        throw new AppError('VALIDATION_ERROR', 'Budget min cannot be more than budget max.');
      }

      const data: Prisma.LeadUpdateInput = {};
      for (const field of Object.keys(changed) as Field[]) Object.assign(data, { [field]: next[field] });

      const phoneChanged = 'phone' in changed;
      const emailChanged = 'email' in changed;
      let normalizedPhone = lead.normalizedPhone;
      let normalizedEmail = lead.normalizedEmail;

      if (phoneChanged) {
        normalizedPhone = next.phone ? this.dialable(next.phone as string) : null;
        data.normalizedPhone = normalizedPhone;
        data.phoneValid = Boolean(normalizedPhone);
      }
      if (emailChanged) {
        normalizedEmail = next.email ? (next.email as string).toLowerCase() : null;
        data.normalizedEmail = normalizedEmail;
        data.emailValid = Boolean(normalizedEmail);
      }

      let reasons = lead.reviewReasons;
      if (phoneChanged) {
        // The old number's complaints no longer describe this lead.
        reasons = reasons.filter((r) => !isPhoneReason(r));
        // Held only for its phone: still held, for a person to approve, never released by an edit.
        if (lead.needsReview && lead.automationPaused && reasons.length === 0 && lead.reviewReasons.length > 0) {
          reasons = [PHONE_CORRECTED_REASON];
        }
      }

      // Someone who asked not to be contacted stays that way, whatever number or address they come back under.
      const becameDoNotContact =
        !lead.dncStatus &&
        (phoneChanged || emailChanged) &&
        (await startsDoNotContact(tx, orgId, normalizedPhone, emailChanged ? normalizedEmail : null));
      if (becameDoNotContact) {
        data.dncStatus = true;
        data.automationPaused = true;
        if (!reasons.includes(EDIT_DNC_REASON)) reasons = [...reasons, EDIT_DNC_REASON];
      }

      const reasonsChanged = reasons.length !== lead.reviewReasons.length || reasons.some((r, i) => r !== lead.reviewReasons[i]);
      if (reasonsChanged) {
        data.reviewReasons = reasons;
        data.needsReview = reasons.length > 0 && (lead.needsReview || becameDoNotContact);
      }

      await tx.lead.update({ where: { id: leadId }, data });
      await this.audit.record(
        {
          orgId,
          actorType: 'user',
          actorId: userId,
          action: 'lead.updated',
          entityType: 'lead',
          entityId: leadId,
          payload: { changed: labelled(changed), becameDoNotContact } as Prisma.InputJsonValue,
        },
        tx,
      );
      return { changed: labelled(changed), becameDoNotContact, phoneChanged };
    });

    const { changed, becameDoNotContact, phoneChanged } = result;
    if (Object.keys(changed).length === 0) return { changed, becameDoNotContact };

    const fields = Object.keys(changed);
    this.state.quietly({
      orgId,
      leadId,
      type: 'lead_edited',
      source: 'agent',
      actor: { type: 'user', id: userId },
      reason: `Edited by hand: ${fields.join(', ')}${becameDoNotContact ? ' — now do-not-contact' : ''}`,
      payload: { changed, becameDoNotContact } as Prisma.InputJsonValue,
    });
    // The zone is worked out from the phone: queued calls and texts are measured against the new one now.
    if (phoneChanged) await this.timezones.wake(leadId);
    this.logger.log(`lead edited org=${orgId} lead=${leadId} fields=${fields.join(',')} dnc=${becameDoNotContact}`);
    this.events.publish({ organizationId: orgId, type: 'lead.updated', leadSourceId: null, leadId });
    return { changed, becameDoNotContact };
  }

  /** The lead's fields as they will be: what was sent, else what is stored. */
  private desired(lead: Current, input: UpdateLeadDto): Record<Field, Value> {
    const sent: Record<Field, Value | undefined> = {
      firstName: input.firstName,
      lastName: input.lastName,
      phone: input.phone,
      email: input.email,
      location: input.location,
      timeline: input.timeline,
      minBudget: input.minBudget,
      maxBudget: input.maxBudget,
      bedrooms: input.bedrooms,
      financingStatus: input.financingStatus,
      motivation: input.notes,
    };
    const out = {} as Record<Field, Value>;
    for (const field of Object.keys(EDITABLE) as Field[]) out[field] = sent[field] !== undefined ? sent[field] : plain(lead[field]);
    return out;
  }

  private diff(lead: Current, next: Record<Field, Value>): Changes {
    const changed: Changes = {};
    for (const field of Object.keys(EDITABLE) as Field[]) {
      const before = plain(lead[field]);
      if (before !== next[field]) changed[field] = [before, next[field]];
    }
    return changed;
  }

  /**
   * E.164, or a validation error. No country is assumed from the digits: the same ten digits are
   * a valid number in dozens of countries, and a wrong guess is a lead nobody can reach.
   */
  private dialable(phone: string): string {
    const parsed = parsePhoneNumberFromString(phone);
    if (!parsed?.isValid()) {
      throw new AppError(
        'VALIDATION_ERROR',
        `"${phone}" is not a phone number we can dial. Start with the country code, e.g. +91 98765 43210.`,
      );
    }
    return parsed.number;
  }
}
