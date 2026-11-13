import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, QueueState, SignatureState } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { GoogleConnectionsService } from '@/google-sheets/google-connections.service';
import { GoogleClient } from '@/google-sheets/google.client';
import { IngestService } from '@/ingest/ingest.service';
import { ProcessingWorker } from '@/ingest/processing/worker.service';
import {
  GOOGLE_FORMS_PROVIDER,
  GOOGLE_FORMS_RECOVERED_EVENT_TYPE,
  LEASE_STUCK_SECONDS,
  POLL_OVERLAP_MS,
  POLL_PAGE_SIZE,
} from './constants';
import { formTitle } from './forms-schema';
import { fieldsOf, responsePayload, wasEdited, type GoogleFormResponsePage } from './forms-responses';
import { GoogleFormsService } from './google-forms.service';

interface Claimed {
  id: string;
  organization_id: string;
  external_form_id: string | null;
  integration_id: string | null;
  remote_synced_at: Date | null;
  sync_failures: number;
}

interface RunStats {
  read: number;
  recovered: number;
  edited: number;
  alreadyHad: number;
}

/**
 * The recovery poller: the safety net under the Apps Script, never the way
 * responses normally arrive.
 *
 * The script on the owner's form is the delivery mechanism. It retries what it
 * can, but it cannot retry forever (and cannot run at all while the owner's
 * quota is spent, or if someone deletes the trigger), and nothing in Google
 * Forms will re-send a response we were down for. So every switched-on form is
 * re-read on a slow interval and anything missing is turned into the delivery
 * that never arrived.
 *
 * It never creates a lead. It writes an ingest_events row with the same dedupe
 * key the webhook would have produced — `GOOGLE_FORMS:<responseId>`, unique per
 * source — so a response that did arrive is skipped by the database itself,
 * and one that did not goes through the ordinary worker. There is no second
 * path into the leads table.
 *
 * Deliberately NOT used as a change detector: Drive's `file.version`. A form's
 * version tracks edits to the FORM, not responses to it, so a version that has
 * not moved says nothing about whether anybody submitted anything.
 */
@Injectable()
export class FormsPollService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger('FormsPoll');
  private readonly instanceId = `forms-${randomUUID()}`;
  private draining: Promise<void> | null = null;
  private again = false;
  private stopped = false;
  private timer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly forms: GoogleFormsService,
    private readonly ingest: IngestService,
    private readonly worker: ProcessingWorker,
    private readonly audit: AuditService,
    private readonly config: ConfigService<IntegrationEnv, true>,
  ) {}

  private get enabled(): boolean {
    return this.config.get('GOOGLE_FORMS_ENABLED', { infer: true });
  }

  onModuleInit(): void {
    if (!this.enabled) {
      this.logger.log('Google Forms recovery poller off (GOOGLE_FORMS_ENABLED=false)');
      return;
    }
    this.timer = setInterval(() => this.nudge(), this.config.get('FORMS_POLL_MS', { infer: true }));
    this.timer.unref();
    this.nudge();
  }

  onModuleDestroy(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  nudge(): void {
    void this.drain();
  }

  drain(): Promise<void> {
    if (!this.enabled) return Promise.resolve();
    if (this.draining) {
      this.again = true;
      return this.draining;
    }
    this.draining = this.loop().finally(() => {
      this.draining = null;
    });
    return this.draining;
  }

  private async loop(): Promise<void> {
    try {
      do {
        this.again = false;
        for (;;) {
          if (this.stopped) return;
          const claimed = await this.claim();
          if (!claimed) break;
          await this.run(claimed);
        }
      } while (this.again && !this.stopped);
    } catch (error) {
      this.logger.error(`Google Forms poll loop failed: ${(error as Error).message}`);
    }
  }

  /**
   * One due form, leased. `FOR UPDATE SKIP LOCKED` is what lets several API
   * instances run this side by side without two of them reading one form at
   * once; a lease older than LEASE_STUCK_SECONDS belonged to an instance that
   * died and is taken over.
   */
  private async claim(only?: { orgId: string; sourceId: string }): Promise<Claimed | null> {
    const rows = await this.prisma.$queryRaw<Claimed[]>`
      WITH due AS (
        SELECT id FROM lead_sources
         WHERE provider = 'GOOGLE_FORMS'
           AND is_active AND archived_at IS NULL AND ingest_status = 'ACTIVE'
           AND sync_next_at IS NOT NULL AND sync_next_at <= now()
           AND (sync_locked_at IS NULL OR sync_locked_at < now() - make_interval(secs => ${LEASE_STUCK_SECONDS}))
           ${only ? Prisma.sql`AND id = ${only.sourceId}::uuid AND organization_id = ${only.orgId}::uuid` : Prisma.empty}
         ORDER BY sync_next_at, id
         FOR UPDATE SKIP LOCKED
         LIMIT 1
      )
      UPDATE lead_sources s
         SET sync_locked_at = now(), sync_locked_by = ${this.instanceId}
        FROM due
       WHERE s.id = due.id
      RETURNING s.id, s.organization_id, s.external_form_id, s.integration_id, s.remote_synced_at, s.sync_failures`;
    return rows[0] ?? null;
  }

  /** Polls one form now, whatever its schedule says. Used by "Check now". */
  async runNow(orgId: string, sourceId: string): Promise<boolean> {
    if (!this.enabled) return false;
    await this.prisma.leadSource.updateMany({ where: { id: sourceId, orgId }, data: { syncNextAt: new Date() } });
    const claimed = await this.claim({ orgId, sourceId });
    if (!claimed) return false;
    await this.run(claimed);
    return true;
  }

  private async run(c: Claimed): Promise<void> {
    const started = Date.now();
    const stats: RunStats = { read: 0, recovered: 0, edited: 0, alreadyHad: 0 };
    try {
      await this.poll(c, stats);
      await this.prisma.leadSource.updateMany({
        where: { id: c.id },
        data: {
          remoteSyncedAt: new Date(),
          syncNextAt: new Date(Date.now() + this.config.get('FORMS_SYNC_INTERVAL_MS', { infer: true })),
          syncLockedAt: null,
          syncLockedBy: null,
          syncFailures: 0,
          ...(stats.recovered > 0 ? { lastEventAt: new Date() } : {}),
        },
      });
      if (stats.recovered > 0) {
        this.logger.log(`Form ${c.id}: recovered ${stats.recovered} response(s) the Apps Script never delivered`);
        this.worker.nudge();
        await this.audit.record({
          orgId: c.organization_id,
          actorType: 'system',
          action: 'google_form.poll_recovered',
          entityType: 'lead_source',
          entityId: c.id,
          payload: { ...stats },
          durationMs: Date.now() - started,
        });
      }
    } catch (error) {
      await this.fail(c, error);
    }
  }

  private async poll(c: Claimed, stats: RunStats): Promise<void> {
    const source = await this.forms.mustFind(c.organization_id, c.id);
    const form = await this.forms.readForm(c.organization_id, c.integration_id ?? '', c.external_form_id ?? '');
    const fields = fieldsOf(form);
    if (fields.length === 0) return;
    // The read does double duty: it is what notices the owner changed a
    // question (and flags the mapping for review), and it is what maps
    // Google's question ids back onto our field keys below. Passing what we
    // already have keeps it to one forms.get per poll.
    await this.forms.syncSchema(source, fields);

    // Overlap the window: a response submitted a moment before the last poll
    // finished would otherwise fall between two filters and never be read. Any
    // response read twice is refused by the dedupe key, so overlap costs
    // nothing but a little bandwidth.
    const since = c.remote_synced_at ? new Date(c.remote_synced_at.getTime() - POLL_OVERLAP_MS) : null;
    const base = {
      sourceId: c.id,
      formId: c.external_form_id ?? '',
      formTitle: formTitle(form),
      fields,
    };

    let pageToken: string | null = null;
    do {
      const page: GoogleFormResponsePage = await this.connections.withAccessToken(c.organization_id, c.integration_id ?? '', (token) =>
        this.google.formResponses<GoogleFormResponsePage>(token, base.formId, { since, pageSize: POLL_PAGE_SIZE, pageToken }),
      );
      for (const response of page.responses ?? []) {
        if (!response.responseId) continue;
        stats.read += 1;
        await this.recover(c, base, response, stats);
      }
      pageToken = page.nextPageToken ?? null;
    } while (pageToken && !this.stopped);
  }

  /**
   * Stores one response as a delivery, unless we already have it.
   *
   * `skipDuplicates` on the unique (lead_source_id, dedupe_key) is the whole
   * duplicate defence, and it is the database's, not a check-then-write race
   * between this poller and an Apps Script delivery arriving at the same
   * moment.
   */
  private async recover(
    c: Claimed,
    base: { sourceId: string; formId: string; formTitle: string; fields: ReturnType<typeof fieldsOf> },
    response: Parameters<typeof responsePayload>[1],
    stats: RunStats,
  ): Promise<void> {
    const payload = responsePayload(base, response);
    const body = JSON.stringify(payload);
    const dedupeKey = `${GOOGLE_FORMS_PROVIDER}:${payload.responseId}`;

    const created = await this.prisma.ingestEvent.createMany({
      data: [
        {
          id: randomUUID(),
          orgId: c.organization_id,
          leadSourceId: c.id,
          provider: GOOGLE_FORMS_PROVIDER,
          eventType: GOOGLE_FORMS_RECOVERED_EVENT_TYPE,
          dedupeKey,
          providerEventId: payload.responseId,
          providerSubmissionId: payload.responseId,
          providerFormId: payload.formId,
          providerCreatedAt: new Date(payload.submittedAt),
          rawBody: body,
          payload: payload as unknown as Prisma.InputJsonValue,
          payloadHash: sha256Hex(body),
          // Read from Google over an authenticated connection rather than
          // posted to us, so there is no signature to have an opinion about.
          signatureState: SignatureState.NOT_CONFIGURED,
          queueState: QueueState.PENDING,
          outcomeReason: null,
          availableAt: new Date(),
        },
      ],
      skipDuplicates: true,
    });

    if (created.count > 0) {
      stats.recovered += 1;
      return;
    }

    stats.alreadyHad += 1;
    // We already have this response. The only thing left worth knowing is
    // whether the respondent has edited it since — in which case the lead is
    // flagged, never rewritten under an owner who has already read it.
    const existing = await this.prisma.ingestEvent.findUnique({
      where: { leadSourceId_dedupeKey: { leadSourceId: c.id, dedupeKey } },
      select: { id: true, leadId: true, providerCreatedAt: true },
    });
    if (existing?.leadId && wasEdited(response, existing.providerCreatedAt)) {
      await this.ingest.flagEditedResponse(existing.leadId, existing.id);
      stats.edited += 1;
    }
  }

  /** A failed poll backs off and says why, in words an owner can act on. */
  private async fail(c: Claimed, error: unknown): Promise<void> {
    const failures = c.sync_failures + 1;
    const message = error instanceof Error ? error.message : String(error);
    const backoff = Math.min(2 ** failures * 60_000, 6 * 60 * 60_000);
    this.logger.warn(`Form ${c.id} poll failed (attempt ${failures}): ${message}`);
    await this.prisma.leadSource.updateMany({
      where: { id: c.id },
      data: {
        syncLockedAt: null,
        syncLockedBy: null,
        syncFailures: failures,
        syncNextAt: new Date(Date.now() + backoff),
        lastFailureAt: new Date(),
        remoteErrorCode: codeOf(error),
        remoteErrorMessage: message.slice(0, 500),
      },
    });
  }
}

function codeOf(error: unknown): string {
  const e = error as { code?: unknown; response?: { error?: { code?: unknown } } };
  if (typeof e?.code === 'string') return e.code.slice(0, 50);
  const nested = (error as { error?: { code?: unknown } })?.error?.code;
  return typeof nested === 'string' ? nested.slice(0, 50) : 'POLL_FAILED';
}
