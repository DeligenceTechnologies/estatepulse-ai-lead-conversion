import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { CALL_TOOLS_VERSION, callToolsSettings, withCallToolsSection, withoutCallToolsSection, type StoredCallTools } from '@/telnyx/tools/call-tools';
import { editRetellLlm } from './retell-api';
import { RetellCredentialsService, type RetellCreds } from './retell-credentials.service';
import { retargetOurTools, retellOutcomeTools, type RetellSession } from './retell-tools';

/** What is on the organization's Retell LLMs for the call-outcome tools; only the token's hash is kept here. */
export interface RetellCallTools {
  tokenHash: string;
  /** The API base the tools point at; a new one provisions them again. */
  url: string;
  version: number;
  /** The LLMs (voice, SMS) that carry the tools. */
  llmIds: string[];
}

type Stored = StoredCallTools & { retell?: RetellCallTools | null };

/** How long a provisioning that matched the LLMs is trusted before the database is read again. */
const READY_TTL_MS = 10 * 60_000;

const OUTCOME_TOOL_NAMES = new Set(['schedule_callback', 'record_outcome']);
const notOutcomeTool = (t: { name?: string }) => !(typeof t?.name === 'string' && OUTCOME_TOOL_NAMES.has(t.name));

/**
 * The Retell side of the call-outcome tools (schedule_callback,
 * record_outcome): custom functions on the organization's voice LLM and, once
 * SMS is set up, its SMS LLM, pointing at the provider-neutral /tools/outcome
 * URL, plus the same marked prompt section the Telnyx assistant gets. On the
 * voice LLM the call identifies the lead; on the SMS LLM the chat id does.
 * Provisioned afresh when an LLM, this server's address or the tool
 * definitions change; off removes just the tools and the section.
 */
@Injectable()
export class RetellToolsService {
  private readonly logger = new Logger(RetellToolsService.name);
  private readonly publicApiUrl: string;
  private readonly ready = new Map<string, number>();
  private readonly queues = new Map<string, Promise<unknown>>();

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: RetellCredentialsService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicApiUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  /** The hash of the bearer token the organization's Retell tools carry; null when the tools are off or not provisioned. */
  async tokenHash(orgId: string): Promise<string | null> {
    const s = await this.settings(orgId);
    return s.enabled ? (s.retell?.tokenHash ?? null) : null;
  }

  /** The tools are on every LLM the organization has, for this server and these definitions. */
  async isCurrent(orgId: string, c: RetellCreds | null): Promise<boolean> {
    const s = await this.settings(orgId);
    return !!s.retell && this.current(s.retell, this.llmsOf(c));
  }

  /** Before a call or a text: makes sure the tools are on the organization's LLMs. Never throws; a failure is logged. */
  async ensure(orgId: string): Promise<void> {
    if ((this.ready.get(orgId) ?? 0) > Date.now()) return;
    await this.serial(orgId, () => this.provision(orgId, false)).catch((error) =>
      this.logger.warn(`Retell call tools for org ${orgId}: ${(error as Error).message}`),
    );
  }

  /** Turning the tools on, or an LLM being added (the SMS agent): provisions now, so a problem shows at once. */
  provisionNow(orgId: string): Promise<void> {
    this.ready.delete(orgId);
    return this.serial(orgId, () => this.provision(orgId, true));
  }

  teardownNow(orgId: string): Promise<void> {
    this.ready.delete(orgId);
    return this.serial(orgId, () => this.teardown(orgId));
  }

  /**
   * Points our tools on the organization's LLMs at this server again when
   * they name an older address. Idempotent: nothing is written when they
   * already do. The token in their headers is kept, so no hash changes.
   */
  async refreshUrls(c: RetellCreds): Promise<void> {
    if (!this.publicApiUrl) return;
    for (const llmId of this.llmsOf(c)) {
      const moved = await editRetellLlm(c.apiKey, llmId, (tools) => {
        const next = retargetOurTools(tools, this.publicApiUrl);
        return next ? { general_tools: next } : null;
      });
      if (moved) this.logger.log(`Retell LLM ${llmId}: our tool URLs moved to ${this.publicApiUrl}`);
    }
  }

  private async settings(orgId: string): Promise<ReturnType<typeof callToolsSettings> & { retell: RetellCallTools | null }> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callTools: true } });
    const raw = (row?.callTools ?? {}) as Stored;
    return { ...callToolsSettings(raw), retell: raw.retell?.tokenHash ? raw.retell : null };
  }

  private llmsOf(c: RetellCreds | null): string[] {
    return [c?.llmId, c?.smsLlmId].filter((id): id is string => !!id);
  }

  private current(t: RetellCallTools, llmIds: string[]): boolean {
    return t.url === this.publicApiUrl && t.version === CALL_TOOLS_VERSION && llmIds.length > 0 && llmIds.every((id) => t.llmIds.includes(id)) && t.llmIds.every((id) => llmIds.includes(id));
  }

  private serial<T>(orgId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(orgId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(run);
    const settled = next.catch(() => undefined);
    this.queues.set(orgId, settled);
    void settled.then(() => {
      if (this.queues.get(orgId) === settled) this.queues.delete(orgId);
    });
    return next;
  }

  private async provision(orgId: string, rethrow: boolean): Promise<void> {
    const s = await this.settings(orgId);
    if (!s.enabled || !this.publicApiUrl) return;
    const c = await this.creds.getCreds(orgId).catch(() => null);
    const llmIds = this.llmsOf(c);
    if (!c?.apiKey || !llmIds.length) {
      if (rethrow) throw new AppError('CONFLICT', 'Create the Retell agent first.');
      return;
    }
    if (s.retell && this.current(s.retell, llmIds)) {
      this.ready.set(orgId, Date.now() + READY_TTL_MS);
      return;
    }

    // One token for both LLMs; an LLM no longer ours (replaced) keeps nothing of ours to remove.
    const token = randomBytes(32).toString('base64url');
    const created: RetellCallTools = { tokenHash: sha256Hex(token), url: this.publicApiUrl, version: CALL_TOOLS_VERSION, llmIds: [] };
    try {
      for (const llmId of llmIds) {
        const session: RetellSession = llmId === c.smsLlmId ? 'chat' : 'call';
        await editRetellLlm(c.apiKey, llmId, (tools, prompt) => ({
          general_tools: [...tools.filter(notOutcomeTool), ...retellOutcomeTools(this.publicApiUrl, token, session)],
          general_prompt: withCallToolsSection(prompt),
        }));
        created.llmIds.push(llmId);
      }
    } catch (error) {
      // What went on stays usable with the new token; the next ensure() finishes the rest.
      if (created.llmIds.length) await this.save(orgId, created);
      if (rethrow) throw error;
      throw new Error(`provisioning failed: ${(error as Error).message}`);
    }
    await this.save(orgId, created);
    this.ready.set(orgId, Date.now() + READY_TTL_MS);
    this.logger.log(`Retell call tools provisioned for org ${orgId} on ${created.llmIds.join(', ')}`);
  }

  private async teardown(orgId: string): Promise<void> {
    const s = await this.settings(orgId);
    if (!s.retell) return;
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (c?.apiKey) {
      for (const llmId of s.retell.llmIds) {
        await editRetellLlm(c.apiKey, llmId, (tools, prompt) => ({
          general_tools: tools.filter(notOutcomeTool),
          general_prompt: withoutCallToolsSection(prompt),
        })).catch((error) => this.logger.warn(`Retell call tools teardown on ${llmId}: ${(error as Error).message}`));
      }
    }
    await this.save(orgId, null);
  }

  /** The Telnyx provisioning and the texts live beside ours in the same JSON; only `retell` is this service's to write. */
  private async save(orgId: string, retell: RetellCallTools | null): Promise<void> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { callTools: true } });
    const current = (row?.callTools ?? {}) as Stored;
    const callTools = { ...current, retell } as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, callTools }, update: { callTools } });
  }
}
