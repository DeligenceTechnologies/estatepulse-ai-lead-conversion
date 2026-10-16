import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  ConnectionMethod,
  IngestStatus,
  LeadSourceProvider,
  MappingStatus,
  type LeadSource,
  type Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '@/common/prisma/prisma.service';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad, generateIngestToken, generateSigningSecret, secretPreview } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { CUSTOM_KEY_PREFIX, CUSTOM_PROVIDER } from '@/custom-webhook/constants';
import { detectAdapter } from '@/custom-webhook/detect';
import { flatten } from '@/custom-webhook/flatten';
import { adapterFor } from '@/ingest/adapters/generic.adapter';
import { IngestService } from '@/ingest/ingest.service';

interface TraceEntry {
  sourceFieldKey: string;
  targetField: string | null;
  outcome: 'mapped' | 'unmapped' | 'transform_error';
  warning?: string | null;
}

/** Sources a webhook delivers to, as opposed to a spreadsheet sync or a file upload. */
const WEBHOOK_SOURCES = { connectionMethod: { in: [ConnectionMethod.MANUAL, ConnectionMethod.API] } } satisfies Prisma.LeadSourceWhereInput;

/** Lead sources fed by a form webhook: create, list, rotate the signing secret, pause, inspect deliveries. */
@Injectable()
export class LeadSourcesService {
  private readonly publicBase: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly secrets: SecretBoxService,
    private readonly ingest: IngestService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicBase = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  ingestUrl(token: string, provider: LeadSourceProvider = LeadSourceProvider.TALLY): string {
    const route =
      provider === LeadSourceProvider.TALLY
        ? 'tally'
        : provider === LeadSourceProvider.TYPEFORM
          ? 'typeform'
          : provider === LeadSourceProvider.CUSTOM
            ? 'custom'
            : 'webhook';
    return `${this.publicBase}/ingest/v1/${route}/${token}`;
  }

  async uniqueCode(orgId: string, name: string): Promise<string> {
    const base =
      name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '_')
        .replace(/^_|_$/g, '')
        .slice(0, 36) || 'webhook';
    let code = base;
    for (let n = 2; await this.prisma.leadSource.findFirst({ where: { orgId, code }, select: { id: true } }); n++) {
      code = `${base.slice(0, 33)}_${n}`;
    }
    return code;
  }

  /** A new source with a fresh ingest token and signing secret, both sealed to the row. */
  newSourceSecrets(orgId: string) {
    const id = randomUUID();
    const token = generateIngestToken('live');
    const secret = generateSigningSecret();
    return {
      id,
      token: token.token,
      secret,
      data: {
        id,
        ingestTokenHash: token.hash,
        ingestTokenPrefix: token.prefix,
        ingestTokenEnc: this.secrets.seal(token.token, aad.ingestToken(orgId, id)),
        signingSecretEnc: this.secrets.seal(secret, aad.signingSecret(orgId, id)),
        signingSecretLast4: secret.slice(-4),
        signingSecretSetAt: new Date(),
        ingestStatus: IngestStatus.AWAITING_FIRST_EVENT,
        mappingStatus: MappingStatus.UNCONFIGURED,
      },
    };
  }

  async create(orgId: string, input: { name: string; requireSignature?: boolean; provider?: LeadSourceProvider }) {
    const provider = input.provider ?? LeadSourceProvider.TALLY;
    const fresh = this.newSourceSecrets(orgId);
    const created = await this.prisma.leadSource.create({
      data: {
        ...fresh.data,
        orgId,
        name: input.name.slice(0, 100),
        code: await this.uniqueCode(orgId, input.name),
        provider,
        connectionMethod: ConnectionMethod.MANUAL,
        requireSignature: input.requireSignature ?? false,
      },
    });
    return { ...this.toSummary(created, fresh.token), signingSecret: fresh.secret };
  }

  async list(orgId: string) {
    const rows = await this.prisma.leadSource.findMany({
      where: { orgId, archivedAt: null, ...WEBHOOK_SOURCES },
      orderBy: { createdAt: 'desc' },
      include: { _count: { select: { ingestEvents: true, leads: true } } },
    });
    return rows.map((row) => ({
      ...this.toSummary(row, this.decryptToken(row)),
      deliveryCount: row._count.ingestEvents,
      leadCount: row._count.leads,
    }));
  }

  async get(orgId: string, id: string) {
    return this.toSummary(await this.mustFind(orgId, id), null, true);
  }

  async rotateSecret(orgId: string, id: string, graceMinutes = 60) {
    const row = await this.mustFind(orgId, id);
    const next = generateSigningSecret();
    await this.prisma.leadSource.update({
      where: { id },
      data: {
        previousSecretEnc: row.signingSecretEnc,
        previousSecretValidUntil: new Date(Date.now() + graceMinutes * 60_000),
        signingSecretEnc: this.secrets.seal(next, aad.signingSecret(orgId, id)),
        signingSecretLast4: next.slice(-4),
        signingSecretSetAt: new Date(),
      },
    });
    return { signingSecret: next, graceMinutes };
  }

  async setPaused(orgId: string, id: string, paused: boolean) {
    const row = await this.mustFind(orgId, id);
    await this.prisma.leadSource.update({
      where: { id },
      data: {
        ingestStatus: paused ? IngestStatus.PAUSED : row.lastSuccessAt ? IngestStatus.ACTIVE : IngestStatus.AWAITING_FIRST_EVENT,
        isActive: !paused,
      },
    });
    if (!paused) await this.ingest.releaseHeld(id);
    return { paused };
  }

  async deliveries(orgId: string, id: string, limit = 25) {
    await this.mustFind(orgId, id);
    const rows = await this.prisma.ingestEvent.findMany({
      where: { orgId, leadSourceId: id },
      orderBy: { receivedAt: 'desc' },
      take: Math.min(Math.max(limit, 1), 100),
      select: {
        id: true,
        provider: true,
        receivedAt: true,
        providerEventId: true,
        signatureState: true,
        usedPreviousSecret: true,
        queueState: true,
        outcome: true,
        outcomeReason: true,
        errorMessage: true,
        contentLength: true,
        payload: true,
        mappingTrace: true,
      },
    });
    return rows.map((r) => {
      const trace = Array.isArray(r.mappingTrace) ? (r.mappingTrace as unknown as TraceEntry[]) : [];
      const byKey = new Map<string, TraceEntry[]>();
      for (const t of trace) if (t?.sourceFieldKey) byKey.set(t.sourceFieldKey, [...(byKey.get(t.sourceFieldKey) ?? []), t]);

      let answers: { label: string; type: string; value: string; targetFields: string[]; mappingOutcome: string | null; warnings: string[] }[] = [];
      let parseError: string | null = null;
      let formName = (r.payload as { data?: { formName?: string } } | null)?.data?.formName ?? null;
      if (r.provider === CUSTOM_PROVIDER) {
        // A custom delivery: a form provider's questions when the payload has
        // a known shape, else every leaf of the payload as a path — either way
        // joined to what the owner's mapping did with it. A field mapped to an
        // extra field was traced under a prefixed key.
        const known = detectAdapter(r.payload)?.parse(r.payload) ?? null;
        if (known) formName = known.providerFormName;
        const fields = known
          ? known.answers.map((a) => ({ key: a.key, label: a.label, type: a.type, value: a.scalarText }))
          : flatten(r.payload).leaves.map((leaf) => ({ key: leaf.path, label: leaf.path, type: leaf.type.toUpperCase(), value: leaf.value }));
        answers = fields.map((f) => {
          const entries = byKey.get(f.key) ?? byKey.get(`${CUSTOM_KEY_PREFIX}${f.key}`) ?? [];
          return {
            label: f.label,
            type: f.type,
            value: f.value,
            targetFields: entries.map((t) => t.targetField).filter((t): t is string => Boolean(t)),
            mappingOutcome: entries[0]?.outcome ?? null,
            warnings: entries.map((t) => t.warning).filter((w): w is string => Boolean(w)),
          };
        });
      } else {
        try {
          answers = adapterFor(r.provider).parse(r.payload).answers.map((a) => {
            const entries = byKey.get(a.key) ?? [];
            return {
              label: a.label,
              type: a.type,
              value: a.scalarText,
              targetFields: entries.map((t) => t.targetField).filter((t): t is string => Boolean(t)),
              mappingOutcome: entries[0]?.outcome ?? null,
              warnings: entries.map((t) => t.warning).filter((w): w is string => Boolean(w)),
            };
          });
        } catch (error) {
          parseError = (error as Error).message;
        }
      }

      return {
        id: r.id,
        receivedAt: r.receivedAt,
        providerEventId: r.providerEventId,
        signatureState: r.signatureState,
        usedPreviousSecret: r.usedPreviousSecret,
        queueState: r.queueState,
        outcome: r.outcome,
        outcomeReason: r.outcomeReason,
        errorMessage: r.errorMessage,
        bodyBytes: r.contentLength,
        formName,
        answers,
        parseError,
        mapping: trace.length
          ? {
              mapped: trace.filter((t) => t.outcome === 'mapped').length,
              unmapped: trace.filter((t) => t.outcome === 'unmapped').length,
              errored: trace.filter((t) => t.outcome === 'transform_error').length,
              warnings: trace.filter((t) => t.warning).length,
            }
          : null,
      };
    });
  }

  async mustFind(orgId: string, id: string) {
    const row = await this.prisma.leadSource.findFirst({ where: { id, orgId } });
    if (!row) throw new NotFoundException({ error: { code: 'NOT_FOUND', message: 'No such lead source.' } });
    return row;
  }

  decryptToken(row: Pick<LeadSource, 'id' | 'orgId' | 'ingestTokenEnc'>): string | null {
    if (!row.ingestTokenEnc) return null;
    try {
      return this.secrets.open(row.ingestTokenEnc, aad.ingestToken(row.orgId, row.id));
    } catch {
      return null;
    }
  }

  toSummary(row: LeadSource, token: string | null, decrypt = false) {
    const webhookToken = token ?? (decrypt ? this.decryptToken(row) : null);
    return {
      id: row.id,
      name: row.name,
      code: row.code,
      isActive: row.isActive,
      requireSignature: row.requireSignature,
      ingestStatus: row.ingestStatus,
      mappingStatus: row.mappingStatus,
      signingSecretPreview: row.signingSecretLast4 ? secretPreview(row.signingSecretLast4) : null,
      signingSecretSetAt: row.signingSecretSetAt,
      externalFormName: row.externalFormName,
      lastEventAt: row.lastEventAt,
      createdAt: row.createdAt,
      webhookUrl: webhookToken ? this.ingestUrl(webhookToken, row.provider) : null,
      provider: row.provider,
      connectionMethod: row.connectionMethod,
      externalFormId: row.externalFormId,
      remoteState: row.remoteState,
      remoteSyncedAt: row.remoteSyncedAt,
      remoteErrorMessage: row.remoteErrorMessage,
    };
  }
}
