import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DeliveryOutcome, IngestStatus, QueueState, SignatureState } from '../../common/domain';
import { SecretBox, sha256Hex, signingSecretAad, verifyTallySignature } from '../../common/crypto';
import { newId } from '../../common/ids';
import { hashCredential, looksLikeIngestToken } from '../../common/tokens';
import { PrismaService } from '../../prisma/prisma.service';
import { TallyAdapter } from './adapters/tally.adapter';
import { InvalidPayloadError } from './adapters/types';

/**
 * Outcome of the synchronous half of ingestion. The controller maps these onto
 * HTTP statuses; nothing here throws for ordinary business failures.
 */
export type IngestResult =
  | { kind: 'accepted'; eventId: string }
  | { kind: 'duplicate'; eventId: string }
  | { kind: 'held'; eventId: string; reason: 'source_paused' }
  | { kind: 'quarantined'; eventId: string | null; reason: 'invalid_signature' | 'signature_required' }
  | { kind: 'invalid_payload'; eventId: string | null; detail: string }
  | { kind: 'unknown_token' }
  | { kind: 'archived' };

const ALLOWED_HEADERS = new Set([
  'content-type',
  'content-length',
  'user-agent',
  'x-forwarded-for',
  'tally-signature',
]);

/**
 * Store only headers we would actually read in support, and never the signature
 * value itself — it is a MAC over the body and belongs in logs no more than the
 * secret does. We keep a boolean instead.
 */
function redactHeaders(headers: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    const key = k.toLowerCase();
    if (!ALLOWED_HEADERS.has(key)) continue;
    out[key] = key === 'tally-signature' ? '[present, redacted]' : String(v);
  }
  return out;
}

@Injectable()
export class IngestService {
  private readonly logger = new Logger(IngestService.name);
  private readonly adapter = new TallyAdapter();
  private readonly secretBox: SecretBox;

  constructor(
    private readonly prismaService: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  private get prisma() {
    return this.prismaService;
  }

  /**
   * The synchronous path. Budget: p99 under 200ms, hard ceiling ~1.5s.
   *
   * Tally's limit is 10 seconds, but treating 10s as the budget is how you end
   * up with five synchronous dependencies and a 3am outage that loses leads.
   * Everything past "the bytes are durably committed" — mapping, phone parsing,
   * identity resolution, merging, scoring — belongs to the worker.
   *
   * The governing principle: **the HTTP status describes the fate of the bytes,
   * never the fate of the lead.** Once the payload is committed we return 2xx
   * unconditionally, because Tally's retry ladder (5m/30m/1h/6h/1d, then an
   * email to the form owner) cannot fix a mapping we misconfigured — it can only
   * generate duplicates and a support ticket.
   */
  async ingestTally(params: {
    token: string;
    rawBody: Buffer;
    headers: Record<string, unknown>;
    signature: string | undefined;
    sourceIp: string | undefined;
  }): Promise<IngestResult> {
    const { token, rawBody, headers, signature, sourceIp } = params;

    // Reject structurally invalid tokens with zero DB round trips — a cheap
    // guard against someone spraying the endpoint.
    if (!looksLikeIngestToken(token)) {
      return { kind: 'unknown_token' };
    }

    const source = await this.prisma.lead_sources.findUnique({
      where: { ingest_token_hash: hashCredential(token) },
    });

    // 404 rather than 401: do not confirm token-space membership, and do not
    // create an unauthenticated write primitive — storing a row per unknown
    // token would be a free storage-exhaustion vector. Log the prefix only.
    if (!source) {
      this.logger.warn(`Ingest rejected: unknown token ${token.slice(0, 12)}…`);
      return { kind: 'unknown_token' };
    }

    if (source.archived_at) {
      return { kind: 'archived' };
    }

    // --- Signature verification -------------------------------------------
    const sig = await this.evaluateSignature(source, rawBody, signature);

    // --- Parse (structural only; mapping is the worker's job) --------------
    let parsedBody: unknown;
    let providerEventId: string | null = null;
    let providerSubmissionId: string | null = null;
    let providerFormId: string | null = null;
    let eventType: string | null = null;
    let providerCreatedAt: Date | null = null;
    let invalidDetail: string | null = null;

    try {
      parsedBody = JSON.parse(rawBody.toString('utf8'));
      const preview = this.adapter.parse(parsedBody);
      providerEventId = preview.providerEventId;
      providerSubmissionId = preview.providerSubmissionId;
      providerFormId = preview.providerFormId;
      eventType = preview.eventType;
      providerCreatedAt = preview.submittedAt;
    } catch (err) {
      invalidDetail =
        err instanceof InvalidPayloadError ? err.message : `Unparseable JSON body: ${String(err)}`;
      parsedBody = null;
    }

    const payloadHash = sha256Hex(rawBody);
    // Tally's eventId is stable across its retry ladder. Falling back to a body
    // hash means an unsigned provider that omits an id is still deduplicated.
    const dedupeKey = providerEventId ? `tally:${providerEventId}` : `sha256:${payloadHash}`;

    // A paused source still records deliveries and holds them, rather than
    // rejecting: pausing is OUR feature, the customer's form is fine. This is
    // the difference between "pause" and "lose".
    const paused = source.ingest_status === IngestStatus.PAUSED || !source.is_active;

    const outcome = sig.quarantine
      ? DeliveryOutcome.QUARANTINED_SIGNATURE
      : invalidDetail
        ? DeliveryOutcome.INVALID_PAYLOAD
        : null;

    // Quarantined and invalid deliveries are stored but never queued: we must
    // not process data whose authenticity we could not establish.
    const queueState = outcome ? QueueState.FAILED : QueueState.PENDING;

    const eventId = newId();
    const created = await this.prisma.webhook_events.createMany({
      data: [
        {
          id: eventId,
          organization_id: source.organization_id,
          lead_source_id: source.id,
          // NOT NULL in the Phase One schema.
          provider: 'TALLY',
          event_type: eventType ?? 'FORM_RESPONSE',
          // A pre-existing partial unique index covers
          // (provider, external_event_id) WHERE external_event_id IS NOT NULL,
          // which gives us a second, cross-source idempotency guarantee for free.
          // Replay rows must leave this NULL or they would violate it.
          external_event_id: providerEventId,
          dedupe_key: dedupeKey,
          payload_hash: payloadHash,
          provider_submission_id: providerSubmissionId,
          provider_form_id: providerFormId,
          // Raw bytes are the source of truth for HMAC re-verification. This is
          // precisely what makes quarantine recoverable: when the customer
          // supplies the correct secret we re-run the HMAC over these bytes and
          // promote whatever now verifies, instead of having destroyed a day of
          // their leads.
          raw_body: rawBody.toString('utf8'),
          payload: (parsedBody ?? {}) as never,
          headers: redactHeaders(headers) as never,
          content_length: rawBody.byteLength,
          signature_verified: sig.state === SignatureState.VALID,
          signature_state: sig.state,
          used_previous_secret: sig.usedPrevious,
          queue_state: queueState,
          // The legacy column, kept coherent for anything reading the old shape.
          processing_status: outcome ? 'failed' : 'received',
          outcome,
          outcome_reason: sig.quarantine
            ? sig.reason
            : invalidDetail
              ? 'invalid_payload'
              : paused
                ? 'source_paused'
                : null,
          error_message: invalidDetail,
          received_at: new Date(),
          provider_created_at: providerCreatedAt,
          // Hold a paused source's backlog rather than dropping it; it drains on
          // resume.
          available_at: paused ? new Date(Date.now() + 100 * 365 * 24 * 3600_000) : new Date(),
        },
      ],
      // Compiles to ON CONFLICT DO NOTHING, which honours ANY unique constraint
      // including our partial `webhook_events_source_dedupe_uniq`. That index is
      // what turns Tally's retry ladder into a no-op, and it is also the ONLY
      // replay defense we have: Tally signs the body with no timestamp, so a
      // captured request stays valid forever.
      skipDuplicates: true,
    });

    if (created.count === 0) {
      // findFirst, not findUnique: the dedupe index is a PARTIAL unique index
      // created in raw SQL, so Prisma does not expose it as a unique selector.
      const existing = await this.prisma.webhook_events.findFirst({
        where: { lead_source_id: source.id, dedupe_key: dedupeKey },
        select: { id: true },
      });
      return { kind: 'duplicate', eventId: existing?.id ?? eventId };
    }

    await this.prisma.lead_sources.update({
      where: { id: source.id },
      data: { last_event_at: new Date() },
    });

    if (sig.quarantine) {
      this.logger.warn(
        `Quarantined delivery ${eventId} for source ${source.id}: ${sig.reason}. ` +
          'Raw body retained for re-verification once the secret is corrected.',
      );
      return { kind: 'quarantined', eventId, reason: sig.reason! };
    }
    if (invalidDetail) return { kind: 'invalid_payload', eventId, detail: invalidDetail };
    if (paused) return { kind: 'held', eventId, reason: 'source_paused' };

    return { kind: 'accepted', eventId };
  }

  /**
   * Verify the signature against the current secret, falling back to the
   * previous one while a rotation grace window is open.
   *
   * The grace window matters operationally: without it, the instant a customer
   * clicks Rotate, every submission fails until they finish pasting the new
   * secret into Tally.
   *
   * The failure mode we design for is not an attacker — it is a customer who
   * rotated the secret in Tally and forgot to tell us. Discarding the body would
   * destroy every submission in that window, and Tally gives up after a day, so
   * the brokerage has paid for leads that no longer exist anywhere.
   */
  private async evaluateSignature(
    source: {
      id: string;
      organization_id: string;
      signing_secret_enc: string | null;
      previous_secret_enc: string | null;
      previous_secret_valid_until: Date | null;
      require_signature: boolean;
    },
    rawBody: Buffer,
    signature: string | undefined,
  ): Promise<{
    state: SignatureState;
    usedPrevious: boolean;
    quarantine: boolean;
    reason?: 'invalid_signature' | 'signature_required';
  }> {
    if (!source.signing_secret_enc) {
      if (source.require_signature) {
        return {
          state: SignatureState.MISSING,
          usedPrevious: false,
          quarantine: true,
          reason: 'signature_required',
        };
      }
      // Tally is signing but we have no secret configured — accept, and let the
      // UI prompt them to add it.
      return { state: SignatureState.NOT_CONFIGURED, usedPrevious: false, quarantine: false };
    }

    if (!signature) {
      return source.require_signature
        ? {
            state: SignatureState.MISSING,
            usedPrevious: false,
            quarantine: true,
            reason: 'signature_required',
          }
        : { state: SignatureState.MISSING, usedPrevious: false, quarantine: false };
    }

    const aad = signingSecretAad(source.organization_id, source.id);
    const current = this.secretBox.decrypt(source.signing_secret_enc, aad);

    if (verifyTallySignature(rawBody, current, signature)) {
      return { state: SignatureState.VALID, usedPrevious: false, quarantine: false };
    }

    const graceOpen =
      source.previous_secret_enc &&
      source.previous_secret_valid_until &&
      source.previous_secret_valid_until > new Date();

    if (graceOpen) {
      const previous = this.secretBox.decrypt(source.previous_secret_enc!, aad);
      if (verifyTallySignature(rawBody, previous, signature)) {
        // Surfaced in the UI as an amber "old secret" chip — a visible nudge to
        // finish the rotation.
        return { state: SignatureState.VALID, usedPrevious: true, quarantine: false };
      }
    }

    return {
      state: SignatureState.INVALID,
      usedPrevious: false,
      quarantine: true,
      reason: 'invalid_signature',
    };
  }
}
