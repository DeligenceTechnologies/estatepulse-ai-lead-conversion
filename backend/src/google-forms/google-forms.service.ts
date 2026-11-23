import { Injectable, Logger } from '@nestjs/common';
import {
  ConnectionMethod,
  IngestStatus,
  IntegrationProvider,
  MappingOrigin,
  MappingStatus,
  Prisma,
  QueueState,
  type LeadSource,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { AppError, httpError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CAPTURED_DURING_SETUP, AWAITING_MAPPING } from '@/custom-webhook/constants';
import { GoogleConnectionsService, type SessionIdentity } from '@/google-sheets/google-connections.service';
import { FORM_MIME, GoogleApiError, GoogleClient } from '@/google-sheets/google.client';
import { CUSTOM_TARGET, FULL_NAME_TARGET } from '@/google-sheets/sheet-rows';
import { ProcessingWorker } from '@/ingest/processing/worker.service';
import { CANONICAL_FIELDS, IGNORE_TARGET, type CanonicalKey } from '@/ingest/processing/canonical-fields';
import { defaultTransform } from '@/ingest/processing/heuristics';
import { LeadSourcesService } from '@/lead-source/lead-sources.service';
import { prebuildMappings, schemaFingerprint, toSyntheticAnswers } from '@/lead-source/prebuild-mapping';
import { generateAppsScript } from './apps-script';
import { GOOGLE_FORMS_EVENT_TYPE, GOOGLE_FORMS_PROVIDER, SCHEMA_CHANGED_CODE } from './constants';
import { describeGoogleForm, formTitle, type GoogleForm, type GoogleFormsField } from './forms-schema';
import type { SaveFormMappingDto } from './dto/google-forms.dto';

/**
 * Google Forms sources: one connected form each.
 *
 * The lifecycle mirrors the custom webhook's, because the shape of the problem
 * is the same — we cannot install anything on the owner's form ourselves, so
 * the owner pastes something in, and until they have finished setting it up
 * whatever arrives is kept rather than turned into leads:
 *
 *   pick the form  -> NEEDS_MAPPING, inactive, questions read from forms.get
 *   map it         -> CONFIGURED, still inactive
 *   switch it on   -> ACTIVE, the held backlog released and flagged for review
 *
 * Nothing here creates leads. A delivery becomes an ingest_events row and the
 * shared ProcessingWorker makes the lead, exactly as it does for Tally and
 * Typeform — there is no second lead pipeline for Google Forms.
 */

const SOURCE_SELECT = {
  id: true,
  orgId: true,
  name: true,
  externalFormId: true,
  externalFormName: true,
  integrationId: true,
  isActive: true,
  ingestStatus: true,
  mappingStatus: true,
  mappingVersion: true,
  schemaFingerprint: true,
  ingestTokenEnc: true,
  signingSecretEnc: true,
  signingSecretLast4: true,
  lastEventAt: true,
  lastSuccessAt: true,
  lastFailureAt: true,
  remoteSyncedAt: true,
  remoteErrorCode: true,
  remoteErrorMessage: true,
  syncNextAt: true,
  syncLockedAt: true,
  createdAt: true,
} satisfies Prisma.LeadSourceSelect;

type SourceRow = Prisma.LeadSourceGetPayload<{ select: typeof SOURCE_SELECT }>;

const FORM_SOURCE = { provider: GOOGLE_FORMS_PROVIDER, connectionMethod: ConnectionMethod.MANUAL } as const;

export interface FormSourceDTO {
  id: string;
  name: string;
  formId: string | null;
  formUrl: string | null;
  connectionId: string | null;
  /** NEEDS_MAPPING | PAUSED | ACTIVE */
  status: string | null;
  mappingStatus: string | null;
  /** True once the owner has mapped it and switched it on. */
  live: boolean;
  /** Deliveries held until the owner finishes setting the form up. */
  waiting: number;
  lastDeliveryAt: Date | null;
  lastLeadAt: Date | null;
  lastFailureAt: Date | null;
  lastPollAt: Date | null;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  mappingNeedsReview: boolean;
  createdAt: Date;
}

export interface FormQuestionDTO {
  fieldKey: string;
  label: string;
  type: string;
  options: string[];
  /** What the owner (or the pre-mapping) has this question going to. */
  target: string | null;
  /** Never pre-mapped: a consent tick is always the owner's explicit choice. */
  consentCandidate: boolean;
}

@Injectable()
export class GoogleFormsService {
  private readonly logger = new Logger(GoogleFormsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly sources: LeadSourcesService,
    private readonly worker: ProcessingWorker,
    private readonly audit: AuditService,
  ) {}

  /** The same OAuth client, picker keys and scope Google Sheets connects with. */
  publicConfig() {
    return this.connections.publicConfig();
  }

  async list(orgId: string): Promise<FormSourceDTO[]> {
    const rows = await this.prisma.leadSource.findMany({
      where: { orgId, ...FORM_SOURCE, archivedAt: null },
      select: SOURCE_SELECT,
      orderBy: { createdAt: 'desc' },
    });
    return Promise.all(rows.map((r) => this.dto(r)));
  }

  /**
   * Connects a form the owner picked in the Google Picker.
   *
   * `forms.get` is called before anything is written, which does three jobs at
   * once: it proves the file is a form, it proves THIS organization's Google
   * connection can read it (the picker is what grants drive.file access, so a
   * form picked while signed in as another account fails here and says so),
   * and it brings back the questions to pre-map.
   */
  async create(who: SessionIdentity, body: { connectionId: string; formId: string }): Promise<FormSourceDTO> {
    const orgId = who.organizationId;
    const form = await this.readForm(orgId, body.connectionId, body.formId);
    const title = formTitle(form);
    const fields = describeGoogleForm(form);

    const existing = await this.prisma.leadSource.findFirst({
      where: { orgId, ...FORM_SOURCE, externalFormId: body.formId },
      select: { ...SOURCE_SELECT, archivedAt: true },
      orderBy: { createdAt: 'desc' },
    });

    // Already connected here: re-point it at the current Google connection
    // rather than making a second source for one form.
    if (existing && !existing.archivedAt) {
      if (existing.integrationId !== body.connectionId) {
        await this.prisma.leadSource.updateMany({
          where: { id: existing.id, orgId },
          data: { integrationId: body.connectionId },
        });
      }
      return this.dto(await this.mustFind(orgId, existing.id));
    }

    if (existing?.archivedAt) {
      await this.prisma.leadSource.updateMany({
        where: { id: existing.id, orgId },
        data: {
          archivedAt: null,
          integrationId: body.connectionId,
          name: title.slice(0, 100),
          externalFormName: title.slice(0, 255),
          ingestStatus: existing.mappingStatus === MappingStatus.CONFIGURED ? IngestStatus.PAUSED : IngestStatus.NEEDS_MAPPING,
          isActive: false,
          syncNextAt: null,
        },
      });
      await this.record(who, 'google_form.restored', existing.id, { formId: body.formId });
      return this.dto(await this.mustFind(orgId, existing.id));
    }

    const secrets = this.sources.newSourceSecrets(orgId);
    const code = await this.sources.uniqueCode(orgId, `gform ${title}`);
    const name = await this.freeName(orgId, title);

    await this.prisma.leadSource.create({
      data: {
        ...secrets.data,
        orgId,
        name,
        code,
        ...FORM_SOURCE,
        integrationId: body.connectionId,
        externalFormId: body.formId,
        externalFormName: title.slice(0, 255),
        // The Apps Script signs every delivery and we refuse an unsigned one.
        requireSignature: true,
        // Nothing becomes a lead until the owner has mapped the questions and
        // switched the form on; deliveries until then are held, not dropped.
        isActive: false,
        ingestStatus: IngestStatus.NEEDS_MAPPING,
        mappingStatus: MappingStatus.UNCONFIGURED,
      },
    });

    await this.saveCatalog(orgId, secrets.id, fields, { premap: true });
    await this.record(who, 'google_form.connected', secrets.id, { formId: body.formId, questions: fields.length });
    return this.dto(await this.mustFind(orgId, secrets.id));
  }

  /**
   * The questions to map, and what each one currently goes to.
   *
   * Read from the stored catalog, not from Google, so opening the mapping
   * screen is free and works while Google is down. `refresh` re-reads
   * `forms.get`, which is what the "check for changes" action does.
   */
  async questions(orgId: string, sourceId: string, refresh = false): Promise<{ source: FormSourceDTO; questions: FormQuestionDTO[] }> {
    const source = await this.mustFind(orgId, sourceId);
    if (refresh) await this.syncSchema(source);

    const [fields, mappings] = await Promise.all([
      this.prisma.leadSourceField.findMany({ where: { orgId, leadSourceId: sourceId }, orderBy: { firstSeenAt: 'asc' } }),
      this.prisma.leadSourceFieldMapping.findMany({ where: { orgId, leadSourceId: sourceId, isActive: true } }),
    ]);

    const byKey = new Map<string, string[]>();
    for (const m of mappings) byKey.set(m.sourceFieldKey, [...(byKey.get(m.sourceFieldKey) ?? []), m.targetField]);

    return {
      source: await this.dto(refresh ? await this.mustFind(orgId, sourceId) : source),
      questions: fields.map((f) => {
        const targets = byKey.get(f.fieldKey) ?? [];
        // first_name + last_name from one question is how a full-name question
        // is stored; the owner picked "Full name", so show them that back.
        const target = targets.includes('first_name') && targets.includes('last_name') ? FULL_NAME_TARGET : (targets[0] ?? null);
        const options = ((f.options ?? []) as { text?: string }[]).map((o) => o?.text ?? '').filter(Boolean);
        return {
          fieldKey: f.fieldKey,
          label: f.label,
          type: f.fieldType,
          options,
          target,
          consentCandidate: f.fieldType === 'CHECKBOXES' && options.length <= 1,
        };
      }),
    };
  }

  /**
   * Saves the owner's mapping. Every question they left alone stays unmapped —
   * an unmapped answer rides along as a custom field and is never guessed into
   * a lead column.
   */
  async saveMapping(who: SessionIdentity, sourceId: string, body: SaveFormMappingDto): Promise<FormSourceDTO> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    const fields = await this.prisma.leadSourceField.findMany({ where: { orgId, leadSourceId: sourceId } });
    const byKey = new Map(fields.map((f) => [f.fieldKey, f]));

    const rows: { sourceFieldKey: string; targetField: string; transform: Prisma.InputJsonValue }[] = [];
    const errors: { path: string; message: string }[] = [];
    const claimed = new Map<string, string>();

    body.mappings.forEach((m, i) => {
      const field = byKey.get(m.sourceFieldKey);
      if (!field) {
        errors.push({ path: `mappings[${i}].sourceFieldKey`, message: `"${m.sourceFieldKey}" is not a question on this form` });
        return;
      }
      if (m.targetField === IGNORE_TARGET) return;

      const previous = claimed.get(m.targetField);
      if (previous) {
        errors.push({
          path: `mappings[${i}].targetField`,
          message: `${label(m.targetField)} is already taken by "${previous}" — one question each`,
        });
        return;
      }
      claimed.set(m.targetField, field.label);

      // A synthetic answer carries the question's own options, so an enum
      // field gets a map built from this form's wording, not a guess.
      const [answer] = toSyntheticAnswers([
        {
          key: field.fieldKey,
          label: field.label,
          type: field.fieldType,
          options: (field.options ?? []) as { id: string; text: string }[],
          externalQuestionId: '',
          booleanOptIn: false,
        },
      ]);

      if (m.targetField === FULL_NAME_TARGET) {
        rows.push({ sourceFieldKey: field.fieldKey, targetField: 'first_name', transform: { kind: 'name_split', part: 'first' } });
        rows.push({ sourceFieldKey: field.fieldKey, targetField: 'last_name', transform: { kind: 'name_split', part: 'last' } });
        return;
      }
      rows.push({
        sourceFieldKey: field.fieldKey,
        targetField: m.targetField,
        transform: defaultTransform(m.targetField as CanonicalKey, answer) as unknown as Prisma.InputJsonValue,
      });
    });

    // Both halves of a full-name mapping claim a column, so the clash check
    // above has to run after they are expanded too.
    const taken = new Set<string>();
    for (const r of rows) {
      if (taken.has(r.targetField)) {
        errors.push({ path: 'mappings', message: `${label(r.targetField)} is mapped twice` });
      }
      taken.add(r.targetField);
    }
    if (errors.length > 0) throw new AppError('VALIDATION_ERROR', 'That mapping does not fit this form', errors);

    const fields_ = await this.describedFromCatalog(orgId, sourceId);
    await this.prisma.$transaction(async (tx) => {
      await tx.leadSourceFieldMapping.deleteMany({ where: { orgId, leadSourceId: sourceId } });
      if (rows.length > 0) {
        await tx.leadSourceFieldMapping.createMany({
          data: rows.map((r) => ({ orgId, leadSourceId: sourceId, ...r, isActive: true, origin: MappingOrigin.USER })),
        });
      }
      await tx.leadSource.updateMany({
        where: { id: sourceId, orgId },
        data: {
          mappingStatus: MappingStatus.CONFIGURED,
          mappingVersion: { increment: 1 },
          // The mapping now matches the form as it is, so a stale
          // "questions changed" warning is cleared with it.
          schemaFingerprint: schemaFingerprint(fields_),
          ingestStatus: source.ingestStatus === IngestStatus.NEEDS_MAPPING ? IngestStatus.PAUSED : undefined,
          remoteErrorCode: source.remoteErrorCode === SCHEMA_CHANGED_CODE ? null : undefined,
          remoteErrorMessage: source.remoteErrorCode === SCHEMA_CHANGED_CODE ? null : undefined,
        },
      });
    });

    await this.record(who, 'google_form.mapping_saved', sourceId, { mapped: rows.length });
    return this.dto(await this.mustFind(orgId, sourceId));
  }

  /**
   * Switches the form on. Anything the Apps Script delivered during setup is
   * released now — as leads that are paused and flagged for review, never
   * auto-contacted, because nobody had looked at the mapping when they landed.
   */
  async activate(who: SessionIdentity, sourceId: string): Promise<FormSourceDTO & { released: number }> {
    const orgId = who.organizationId;
    const source = await this.mustFind(orgId, sourceId);
    if (source.mappingStatus !== MappingStatus.CONFIGURED) {
      throw httpError(409, 'MAPPING_REQUIRED', 'Map the form’s questions before switching it on.');
    }
    await this.assertConnectionLive(orgId, source);

    const released = await this.prisma.$transaction(async (tx) => {
      await tx.leadSource.updateMany({
        where: { id: sourceId, orgId },
        data: {
          isActive: true,
          ingestStatus: IngestStatus.ACTIVE,
          // Due for its first recovery poll straight away, which also catches
          // anything submitted before the script was installed.
          syncNextAt: new Date(),
          remoteErrorCode: null,
          remoteErrorMessage: null,
          syncFailures: 0,
        },
      });
      const rel = await tx.ingestEvent.updateMany({
        where: { orgId, leadSourceId: sourceId, queueState: QueueState.PENDING, outcomeReason: AWAITING_MAPPING },
        data: { outcomeReason: CAPTURED_DURING_SETUP, availableAt: new Date() },
      });
      return rel.count;
    });

    await this.record(who, 'google_form.activated', sourceId, { released });
    if (released > 0) this.worker.nudge();
    return { ...(await this.dto(await this.mustFind(orgId, sourceId))), released };
  }

  async pause(who: SessionIdentity, sourceId: string): Promise<FormSourceDTO> {
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { ingestStatus: IngestStatus.PAUSED, isActive: false, syncNextAt: null },
    });
    await this.record(who, 'google_form.paused', sourceId, {});
    return this.dto(await this.mustFind(orgId, sourceId));
  }

  /**
   * Archives the form source. Its leads stay. The Apps Script on the owner's
   * form keeps firing at a URL that now answers 410, which is what tells them
   * to delete it — we cannot reach into their form to remove it ourselves.
   */
  async remove(who: SessionIdentity, sourceId: string): Promise<{ removed: true }> {
    const orgId = who.organizationId;
    await this.mustFind(orgId, sourceId);
    await this.prisma.leadSource.updateMany({
      where: { id: sourceId, orgId },
      data: { archivedAt: new Date(), isActive: false, ingestStatus: IngestStatus.PAUSED, syncNextAt: null },
    });
    await this.record(who, 'google_form.removed', sourceId, {});
    return { removed: true };
  }

  /** The generated script, with this source's own URL and signing key in it. */
  async appsScript(orgId: string, sourceId: string): Promise<{ script: string; webhookUrl: string; formId: string }> {
    const source = await this.mustFind(orgId, sourceId);
    const token = this.sources.decryptToken(source);
    if (!token || !source.signingSecretEnc) {
      throw httpError(409, 'SOURCE_NOT_READY', 'This form has no delivery key yet. Remove it and add it again.');
    }
    const secret = this.sources.decryptSigningSecret(source);
    if (!secret) throw httpError(409, 'SOURCE_NOT_READY', 'This form has no delivery key yet. Remove it and add it again.');
    const webhookUrl = this.sources.ingestUrl(token, GOOGLE_FORMS_PROVIDER);
    return {
      script: generateAppsScript({
        webhookUrl,
        signingSecret: secret,
        formId: source.externalFormId ?? '',
        sourceId: source.id,
        formName: source.externalFormName ?? source.name,
      }),
      webhookUrl,
      formId: source.externalFormId ?? '',
    };
  }

  /**
   * What the owner's "Test connection" asks: can we still read this form, and
   * has the script on it ever actually delivered anything?
   */
  async test(orgId: string, sourceId: string) {
    const source = await this.mustFind(orgId, sourceId);
    let readable = false;
    let error: string | null = null;
    try {
      await this.readForm(orgId, source.integrationId ?? '', source.externalFormId ?? '');
      readable = true;
    } catch (e) {
      error = e instanceof Error ? e.message : String(e);
    }

    const [byType, lastDelivery] = await Promise.all([
      this.prisma.ingestEvent.groupBy({
        by: ['eventType'],
        where: { orgId, leadSourceId: sourceId },
        _count: true,
      }),
      this.prisma.ingestEvent.findFirst({
        where: { orgId, leadSourceId: sourceId },
        orderBy: { receivedAt: 'desc' },
        select: { receivedAt: true, outcome: true, outcomeReason: true, errorMessage: true },
      }),
    ]);

    // Only what the SCRIPT posted proves the script works. The recovery poll
    // fetches the same responses out of Google minutes later, so counting its
    // events here would report a healthy form while every push is failing —
    // which is exactly the case this test exists to catch.
    const pushed = byType.find((row) => row.eventType === GOOGLE_FORMS_EVENT_TYPE)?._count ?? 0;
    const deliveries = byType.reduce((total, row) => total + row._count, 0);

    return {
      formReadable: readable,
      googleError: error,
      deliveries,
      pushDeliveries: pushed,
      recoveredDeliveries: deliveries - pushed,
      scriptInstalled: pushed > 0,
      lastDeliveryAt: lastDelivery?.receivedAt ?? null,
      lastDeliveryOutcome: lastDelivery?.outcome ?? null,
      lastDeliveryReason: lastDelivery?.outcomeReason ?? lastDelivery?.errorMessage ?? null,
      lastPollAt: source.remoteSyncedAt,
      lastErrorCode: source.remoteErrorCode,
      lastErrorMessage: source.remoteErrorMessage,
    };
  }

  // --- internals ----------------------------------------------------------

  /** Reads `forms.get` through the organization's own Google connection. */
  async readForm(orgId: string, connectionId: string, formId: string): Promise<GoogleForm> {
    if (!formId) throw httpError(400, 'FORM_ID_REQUIRED', 'No Google Form was selected.');
    return this.connections.withAccessToken(orgId, connectionId, async (token) => {
      // Drive first: it is the only call that can tell a form from a
      // spreadsheet, and its 404 is what a file picked as a different Google
      // account looks like — worth its own sentence to the owner.
      const file = await this.google.driveFile(token, formId);
      if (file.trashed) throw new GoogleApiError('NOT_FOUND', 'The form is in the trash', 404);
      if (file.mimeType !== FORM_MIME) {
        throw httpError(400, 'GOOGLE_NOT_A_FORM', 'That file is not a Google Form.');
      }
      return this.google.form<GoogleForm>(token, formId);
    });
  }

  /**
   * Writes the question catalog, and on a first connection the pre-mapping
   * that lets an owner see sensible defaults before anybody has submitted
   * anything. Consent is never pre-mapped (prebuild-mapping.ts withholds it).
   */
  private async saveCatalog(orgId: string, leadSourceId: string, fields: GoogleFormsField[], opts: { premap: boolean }): Promise<void> {
    if (fields.length === 0) return;
    const prebuilt = opts.premap ? prebuildMappings(fields) : null;

    await this.prisma.$transaction(async (tx) => {
      for (const f of fields) {
        await tx.leadSourceField.upsert({
          where: { leadSourceId_fieldKey: { leadSourceId, fieldKey: f.key } },
          create: {
            orgId,
            leadSourceId,
            fieldKey: f.key,
            label: f.label,
            fieldType: f.type,
            ...(f.options ? { options: f.options as unknown as Prisma.InputJsonValue } : {}),
            // Google's own question id, kept so the original question stays
            // identifiable even after a rename changes its key.
            sampleValues: [f.externalQuestionId].filter(Boolean),
            status: 'NEW',
          },
          update: {
            label: f.label,
            fieldType: f.type,
            ...(f.options ? { options: f.options as unknown as Prisma.InputJsonValue } : {}),
            lastSeenAt: new Date(),
            missingStreak: 0,
            status: 'ACTIVE',
          },
        });
      }
      if (prebuilt && prebuilt.mappings.length > 0) {
        await tx.leadSourceFieldMapping.createMany({
          data: prebuilt.mappings.map((m) => ({
            orgId,
            leadSourceId,
            sourceFieldKey: m.sourceFieldKey,
            targetField: m.targetField,
            transform: m.transform as Prisma.InputJsonValue,
            isActive: true,
            confidence: m.confidence,
            origin: MappingOrigin.PREBUILT,
          })),
          skipDuplicates: true,
        });
      }
      await tx.leadSource.update({
        where: { id: leadSourceId },
        data: {
          ...(prebuilt
            ? {
                mappingStatus: prebuilt.mappings.length ? MappingStatus.NEEDS_REVIEW : MappingStatus.UNCONFIGURED,
                mappingVersion: { increment: 1 },
                prebuiltAt: new Date(),
              }
            : {}),
          schemaFingerprint: schemaFingerprint(fields),
        },
      });
    });
  }

  /**
   * Re-reads the form and, if its questions changed, flags the mapping for
   * review rather than importing answers under the old one.
   *
   * Returns true when something changed. A changed form is not an error and
   * does not stop deliveries — an answer whose question was renamed simply
   * stops matching a mapping and lands in custom fields, which is the safe way
   * to be wrong.
   */
  async syncSchema(source: SourceRow, known?: GoogleFormsField[]): Promise<boolean> {
    let fields: GoogleFormsField[];
    try {
      // The poller has already read the form this run and passes what it got,
      // so a recovery poll costs one forms.get rather than two.
      fields = known ?? describeGoogleForm(await this.readForm(source.orgId, source.integrationId ?? '', source.externalFormId ?? ''));
    } catch (error) {
      this.logger.warn(`Could not re-read form for source ${source.id}: ${(error as Error).message}`);
      return false;
    }
    if (fields.length === 0) return false;

    const fingerprint = schemaFingerprint(fields);
    if (fingerprint === source.schemaFingerprint) return false;

    await this.saveCatalog(source.orgId, source.id, fields, { premap: false });
    // Only a source whose mapping an owner had already settled is worth
    // interrupting; one still being set up is about to be mapped anyway.
    if (source.mappingStatus === MappingStatus.CONFIGURED) {
      await this.prisma.leadSource.updateMany({
        where: { id: source.id, orgId: source.orgId },
        data: {
          mappingStatus: MappingStatus.NEEDS_REVIEW,
          remoteErrorCode: SCHEMA_CHANGED_CODE,
          remoteErrorMessage: 'The form’s questions changed. Check the mapping so answers keep landing in the right fields.',
        },
      });
      this.logger.log(`Form source ${source.id}: questions changed, mapping flagged for review`);
    }
    return true;
  }

  private async describedFromCatalog(orgId: string, leadSourceId: string): Promise<GoogleFormsField[]> {
    const fields = await this.prisma.leadSourceField.findMany({
      where: { orgId, leadSourceId },
      orderBy: { firstSeenAt: 'asc' },
    });
    return fields.map((f) => ({
      key: f.fieldKey,
      label: f.label,
      type: f.fieldType,
      options: (f.options ?? []) as { id: string; text: string }[],
      // Only the label and the type are read back out of here (the schema
      // fingerprint); Google's question id is re-read from forms.get whenever
      // it is actually needed, so it is not worth a column.
      externalQuestionId: '',
      booleanOptIn: false,
    }));
  }

  async mustFind(orgId: string, sourceId: string): Promise<SourceRow> {
    const row = await this.prisma.leadSource.findFirst({
      where: { id: sourceId, orgId, ...FORM_SOURCE, archivedAt: null },
      select: SOURCE_SELECT,
    });
    if (!row) throw httpError(404, 'FORM_SOURCE_NOT_FOUND', 'No such Google Form.');
    return row;
  }

  private async assertConnectionLive(orgId: string, source: SourceRow): Promise<void> {
    const row = source.integrationId
      ? await this.prisma.integration.findFirst({
          where: { id: source.integrationId, orgId, provider: IntegrationProvider.google, revokedAt: null },
          select: { status: true },
        })
      : null;
    if (!row || row.status !== 'active') {
      throw httpError(409, 'GOOGLE_REAUTH_REQUIRED', 'Reconnect Google before switching this form on.');
    }
  }

  private async freeName(orgId: string, title: string): Promise<string> {
    const base = title.slice(0, 100);
    for (let n = 1; n < 50; n++) {
      const name = n === 1 ? base : `${base.slice(0, 94)} (${n})`;
      const clash = await this.prisma.leadSource.findFirst({ where: { orgId, name }, select: { id: true } });
      if (!clash) return name;
    }
    return `${base.slice(0, 88)} ${randomUUID().slice(0, 8)}`;
  }

  private async dto(s: SourceRow): Promise<FormSourceDTO> {
    const waiting = await this.prisma.ingestEvent.count({
      where: { leadSourceId: s.id, queueState: QueueState.PENDING, outcomeReason: AWAITING_MAPPING },
    });
    return {
      id: s.id,
      name: s.name,
      formId: s.externalFormId,
      formUrl: s.externalFormId ? `https://docs.google.com/forms/d/${s.externalFormId}/edit` : null,
      connectionId: s.integrationId,
      status: s.ingestStatus,
      mappingStatus: s.mappingStatus,
      live: s.isActive && s.ingestStatus === IngestStatus.ACTIVE,
      waiting,
      lastDeliveryAt: s.lastEventAt,
      lastLeadAt: s.lastSuccessAt,
      lastFailureAt: s.lastFailureAt,
      lastPollAt: s.remoteSyncedAt,
      lastErrorCode: s.remoteErrorCode,
      lastErrorMessage: s.remoteErrorMessage,
      mappingNeedsReview: s.mappingStatus === MappingStatus.NEEDS_REVIEW,
      createdAt: s.createdAt,
    };
  }

  private record(who: SessionIdentity, action: string, sourceId: string, payload: Prisma.InputJsonObject): Promise<void> {
    return this.audit.record({
      orgId: who.organizationId,
      actorType: 'user',
      actorId: who.userId,
      action,
      entityType: 'lead_source',
      entityId: sourceId,
      payload,
    });
  }
}

const label = (target: string): string =>
  target === FULL_NAME_TARGET ? 'Full name' : target === CUSTOM_TARGET ? 'Extra field' : (CANONICAL_FIELDS[target]?.label ?? target);
