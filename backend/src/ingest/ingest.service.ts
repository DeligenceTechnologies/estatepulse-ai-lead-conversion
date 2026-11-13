import { Injectable, Logger } from '@nestjs/common';
import {
  DeliveryOutcome,
  IngestStatus,
  LeadSourceProvider,
  MappingStatus,
  QueueState,
  SignatureState,
  type LeadSource,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, looksLikeIngestToken, sha256Hex, verifyTallySignature, verifyTypeformSignature } from '@/common/utils/crypto';
import { EventsBus } from '@/events/events.bus';
import { GOOGLE_FORMS_EVENT_TYPE, GOOGLE_FORMS_SIGNATURE_HEADER, RESPONSE_EDITED_REASON } from '@/google-forms/constants';
import { adapterFor } from './adapters/generic.adapter';
import { InvalidPayloadError } from './adapters/types';

export type IngestResult =
  | { kind: 'accepted'; eventId: string }
  | { kind: 'duplicate'; eventId: string }
  | { kind: 'held'; eventId: string }
  | { kind: 'quarantined'; eventId: string; reason: 'invalid_signature' | 'signature_required' }
  | { kind: 'invalid_payload'; eventId: string; detail: string }
  | { kind: 'unknown_token' }
  | { kind: 'archived' };

export type IngestRoute = Extract<LeadSourceProvider, 'TALLY' | 'TYPEFORM' | 'WEBHOOK' | 'GOOGLE_FORMS'>;

const SIGNATURE_HEADERS = new Set(['tally-signature', 'typeform-signature', GOOGLE_FORMS_SIGNATURE_HEADER]);
const ALLOWED_HEADERS = new Set(['content-type', 'content-length', 'user-agent', 'x-forwarded-for', ...SIGNATURE_HEADERS]);
/** A paused source keeps its deliveries queued, far in the future, until it is resumed. */
export const HELD_UNTIL = new Date('9999-12-31T00:00:00Z');

/** Custom webhook deliveries held for the owner's mapping (custom-webhook/constants.ts). Released by activation, not by a resume. */
const AWAITING_MAPPING = 'awaiting_mapping';

interface SignatureVerdict {
  state: SignatureState;
  usedPrevious: boolean;
  quarantine?: 'invalid_signature' | 'signature_required';
}

/**
 * Receives a delivery and stores it, exactly once per source, before anything
 * else happens. Parsing into a lead is the worker's job, so a slow or broken
 * mapping never loses a delivery and never makes the provider retry.
 */
@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly events: EventsBus,
  ) {}

  async receive(params: {
    route: IngestRoute;
    token: string;
    rawBody: Buffer;
    headers: Record<string, unknown>;
    signature: string | undefined;
  }): Promise<IngestResult> {
    const { route, token, rawBody, headers, signature } = params;
    if (!looksLikeIngestToken(token)) return { kind: 'unknown_token' };

    const source = await this.prisma.leadSource.findUnique({ where: { ingestTokenHash: sha256Hex(token) } });
    if (!source) {
      this.logger.warn(`Ingest rejected: unknown token ${token.slice(0, 12)}…`);
      return { kind: 'unknown_token' };
    }
    if (source.archivedAt) return { kind: 'archived' };
    // A custom webhook's token is only good on its own route (CustomWebhookIngestController).
    if (source.provider === LeadSourceProvider.CUSTOM) {
      this.logger.warn(`Ingest rejected: custom webhook token ${token.slice(0, 12)}… on the ${route} route`);
      return { kind: 'unknown_token' };
    }
    // A Typeform token is bound to the Typeform route and no other token is accepted there.
    if ((route === LeadSourceProvider.TYPEFORM) !== (source.provider === LeadSourceProvider.TYPEFORM)) {
      this.logger.warn(`Ingest rejected: ${source.provider} token ${token.slice(0, 12)}… on the ${route} route`);
      return { kind: 'unknown_token' };
    }
    // Same binding for Google Forms: its token works on its own route only, so
    // a leaked Apps Script token cannot be replayed against the generic
    // webhook route to dodge the signature this route insists on.
    if ((route === LeadSourceProvider.GOOGLE_FORMS) !== (source.provider === LeadSourceProvider.GOOGLE_FORMS)) {
      this.logger.warn(`Ingest rejected: ${source.provider} token ${token.slice(0, 12)}… on the ${route} route`);
      return { kind: 'unknown_token' };
    }

    // Google Forms signs as Typeform does — `sha256=` and a base64 HMAC-SHA256
    // of the raw body — which is what Apps Script's Utilities can produce.
    const verify =
      route === LeadSourceProvider.TYPEFORM || route === LeadSourceProvider.GOOGLE_FORMS
        ? verifyTypeformSignature
        : verifyTallySignature;
    const sig = this.evaluateSignature(source, rawBody, signature, verify);
    let payload: unknown = null;
    let invalid: string | null = null;
    let preview = null;
    try {
      payload = JSON.parse(rawBody.toString('utf8'));
      preview = adapterFor(route).parse(payload);
    } catch (error) {
      invalid = error instanceof InvalidPayloadError ? error.message : 'Unparseable JSON body';
    }

    const payloadHash = sha256Hex(rawBody);
    const dedupeKey = preview?.providerEventId ? `${route}:${preview.providerEventId}` : `sha256:${payloadHash}`;
    const paused = source.ingestStatus === IngestStatus.PAUSED || !source.isActive;
    // A Google Forms response that arrives before the owner has finished
    // mapping the form is kept, not dropped and not turned into a lead:
    // activation releases it, flagged, exactly as a custom webhook's backlog is
    // (GoogleFormsService.activate). Resuming a merely paused source does not
    // release these — releaseHeld() skips this reason on purpose.
    const awaitingMapping =
      source.provider === LeadSourceProvider.GOOGLE_FORMS && source.mappingStatus !== MappingStatus.CONFIGURED;
    const held = paused || awaitingMapping;
    const outcome = sig.quarantine
      ? DeliveryOutcome.QUARANTINED_SIGNATURE
      : invalid
        ? DeliveryOutcome.INVALID_PAYLOAD
        : null;

    const eventId = randomUUID();
    const created = await this.prisma.ingestEvent.createMany({
      data: [
        {
          id: eventId,
          orgId: source.orgId,
          leadSourceId: source.id,
          provider: route,
          eventType: preview?.eventType ?? null,
          dedupeKey,
          providerEventId: preview?.providerEventId ?? null,
          providerSubmissionId: preview?.providerSubmissionId ?? null,
          providerFormId: preview?.providerFormId ?? null,
          providerCreatedAt: preview?.submittedAt ?? null,
          rawBody: rawBody.toString('utf8'),
          payload: (payload ?? {}) as Prisma.InputJsonValue,
          payloadHash,
          headers: redactHeaders(headers),
          contentLength: rawBody.byteLength,
          signatureState: sig.state,
          usedPreviousSecret: sig.usedPrevious,
          queueState: outcome ? QueueState.FAILED : QueueState.PENDING,
          outcome,
          outcomeReason:
            sig.quarantine ?? (invalid ? 'invalid_payload' : awaitingMapping ? AWAITING_MAPPING : paused ? 'source_paused' : null),
          errorMessage: invalid,
          availableAt: held ? HELD_UNTIL : new Date(),
        },
      ],
      skipDuplicates: true,
    });

    if (created.count === 0) {
      const existing = await this.prisma.ingestEvent.findUnique({
        where: { leadSourceId_dedupeKey: { leadSourceId: source.id, dedupeKey } },
        select: { id: true, payloadHash: true, leadId: true, eventType: true },
      });
      // Google Forms lets a respondent edit an answer after submitting, and the
      // edit arrives under the SAME response id. The lead is never rewritten
      // underneath an owner who has already read it — it is flagged and its
      // automation paused, which is what the review mechanism is for.
      //
      // Only compared when the stored delivery came from the Apps Script too.
      // A response the recovery poller fetched was rebuilt from the Forms API
      // and never hashes identically to the script's own body, so comparing
      // across the two would call every recovered response an edit. The
      // poller does its own edit check, on Google's lastSubmittedTime.
      if (
        source.provider === LeadSourceProvider.GOOGLE_FORMS &&
        existing?.leadId &&
        existing.eventType === GOOGLE_FORMS_EVENT_TYPE &&
        existing.payloadHash !== payloadHash
      ) {
        await this.flagEditedResponse(existing.leadId, eventId);
      }
      return { kind: 'duplicate', eventId: existing?.id ?? eventId };
    }

    await this.prisma.leadSource.update({ where: { id: source.id }, data: { lastEventAt: new Date() } });
    this.events.publish({ organizationId: source.orgId, type: 'delivery.received', leadSourceId: source.id });

    if (sig.quarantine) {
      this.logger.warn(`Quarantined delivery ${eventId} for source ${source.id}: ${sig.quarantine}`);
      return { kind: 'quarantined', eventId, reason: sig.quarantine };
    }
    if (invalid) return { kind: 'invalid_payload', eventId, detail: invalid };
    if (held) return { kind: 'held', eventId };
    return { kind: 'accepted', eventId };
  }

  /**
   * A response that changed after we made a lead from it: flag the lead and
   * pause its automation, leaving its values alone. Said once — a respondent
   * who edits an answer three times should not leave three identical notes.
   */
  async flagEditedResponse(leadId: string, deliveryId: string): Promise<void> {
    const lead = await this.prisma.lead.findUnique({ where: { id: leadId }, select: { reviewReasons: true } });
    if (!lead || lead.reviewReasons.includes(RESPONSE_EDITED_REASON)) return;
    await this.prisma.lead.update({
      where: { id: leadId },
      data: {
        needsReview: true,
        automationPaused: true,
        reviewReasons: { set: [...lead.reviewReasons, RESPONSE_EDITED_REASON] },
      },
    });
    this.logger.log(`Lead ${leadId} flagged: its Google Forms response was edited (delivery ${deliveryId})`);
  }

  /**
   * Re-queues the deliveries a paused source held, oldest first. A custom
   * webhook's deliveries still waiting for their mapping stay held.
   */
  async releaseHeld(leadSourceId: string): Promise<number> {
    const { count } = await this.prisma.ingestEvent.updateMany({
      where: {
        leadSourceId,
        queueState: QueueState.PENDING,
        availableAt: HELD_UNTIL,
        OR: [{ outcomeReason: null }, { outcomeReason: { not: AWAITING_MAPPING } }],
      },
      data: { availableAt: new Date() },
    });
    return count;
  }

  /**
   * Tally signs the body with no timestamp, so a valid signature is no replay
   * defence on its own: the per-source dedupe key is. A rotated secret keeps
   * verifying during its grace window so a delivery mid-rotation is not lost.
   */
  private evaluateSignature(
    source: LeadSource,
    rawBody: Buffer,
    signature: string | undefined,
    verify: (rawBody: Buffer, secret: string, header: string) => boolean = verifyTallySignature,
  ): SignatureVerdict {
    if (!source.signingSecretEnc || !signature) {
      const state = source.signingSecretEnc ? SignatureState.MISSING : SignatureState.NOT_CONFIGURED;
      return source.requireSignature
        ? { state: SignatureState.MISSING, usedPrevious: false, quarantine: 'signature_required' }
        : { state, usedPrevious: false };
    }
    const secretAad = aad.signingSecret(source.orgId, source.id);
    if (verify(rawBody, this.secrets.open(source.signingSecretEnc, secretAad), signature)) {
      return { state: SignatureState.VALID, usedPrevious: false };
    }
    const graceOpen = source.previousSecretEnc && source.previousSecretValidUntil && source.previousSecretValidUntil > new Date();
    if (graceOpen && verify(rawBody, this.secrets.open(source.previousSecretEnc!, secretAad), signature)) {
      return { state: SignatureState.VALID, usedPrevious: true };
    }
    return { state: SignatureState.INVALID, usedPrevious: false, quarantine: 'invalid_signature' };
  }
}

function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const key = name.toLowerCase();
    if (!ALLOWED_HEADERS.has(key)) continue;
    out[key] = SIGNATURE_HEADERS.has(key) ? '[present, redacted]' : String(value);
  }
  return out;
}
