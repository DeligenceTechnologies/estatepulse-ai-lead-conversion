import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '../common/errors';
import { CredStoreService } from './cred-store.service';
import {
  EXTRACTION_INSTRUCTIONS,
  EXTRACTION_JSON_SCHEMA,
  parseExtraction,
  type Extraction,
} from './lead-scoring';

/* eslint-disable @typescript-eslint/no-explicit-any */

const API = 'https://api.telnyx.com/v2';
const INSIGHT_NAME = 'EstatePulse lead qualification';
const GROUP_NAME = 'EstatePulse';

/**
 * Model for re-reading a stored transcript. One of the models the assistant
 * picker already offers, so it is known to be served by Telnyx.
 */
const TRANSCRIPT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';

/**
 * Speaker labels in our stored transcripts are recording channels, not names,
 * so the model is told how to tell the caller apart.
 */
const TRANSCRIPT_NOTE =
  ' The transcript labels speakers by recording channel (for example "Channel 1" and "Channel 2"); ' +
  'the assistant is the speaker asking the qualification questions, and the caller is the other one.';

/**
 * The Telnyx side of lead temperature: Telnyx's own post-call AI Insights do
 * the reading, so this only makes sure the office's assistant has our Insight,
 * and re-reads old transcripts on request.
 *
 * Setup is automatic and idempotent. It runs when a call is answered, at most
 * once per assistant per process, and adds to whatever the office has already
 * configured in Telnyx: if the assistant already has an insight group, our
 * Insight joins it rather than replacing it.
 */
@Injectable()
export class LeadInsightsService {
  private readonly logger = new Logger(LeadInsightsService.name);
  /** `${orgId}:${assistantId}` keys known to be set up in this process. */
  private readonly provisioned = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly creds: CredStoreService) {}

  /** Never throws: a call must go ahead even if Telnyx setup fails. A failure retries on the next call. */
  async ensureProvisioned(orgId: string): Promise<void> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (!c?.apiKey || !c.assistantId) return;

    const key = `${orgId}:${c.assistantId}`;
    if (this.provisioned.has(key)) return;
    const running = this.inflight.get(key);
    if (running) return running;

    const run = this.provision(c.apiKey, c.assistantId)
      .then(() => {
        this.provisioned.add(key);
      })
      .catch((e) => this.logger.warn(`lead insight setup for org ${orgId}: ${(e as Error).message}`))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async provision(apiKey: string, assistantId: string): Promise<void> {
    const call = (path: string, init: RequestInit = {}) => telnyx(apiKey, path, init);

    // 1. Our Insight, kept in step with the schema this code scores against.
    const insights: any[] = (await call('/ai/conversations/insights?page[size]=99')).data ?? [];
    const body = { name: INSIGHT_NAME, instructions: EXTRACTION_INSTRUCTIONS, json_schema: EXTRACTION_JSON_SCHEMA };
    const existing = insights.find((i) => i.name === INSIGHT_NAME);
    const insightId: string = existing
      ? (await call(`/ai/conversations/insights/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) })).data?.id ?? existing.id
      : (await call('/ai/conversations/insights', { method: 'POST', body: JSON.stringify(body) })).data.id;

    // 2. The assistant's insight group — the office's own if it has one.
    // GET /ai/assistants/{id} answers with the assistant itself, not under `data`.
    const raw = await call(`/ai/assistants/${assistantId}`);
    const assistant = raw?.data ?? raw ?? {};
    let groupId: string | undefined = assistant.insight_settings?.insight_group_id;
    if (!groupId) {
      const groups: any[] = (await call('/ai/conversations/insight-groups?page[size]=99')).data ?? [];
      groupId =
        groups.find((g) => g.name === GROUP_NAME)?.id ??
        (await call('/ai/conversations/insight-groups', { method: 'POST', body: JSON.stringify({ name: GROUP_NAME }) })).data.id;
      await call(`/ai/assistants/${assistantId}`, {
        method: 'POST',
        body: JSON.stringify({ insight_settings: { insight_group_id: groupId } }),
      });
    }

    // 3. Our Insight in that group.
    const group = (await call(`/ai/conversations/insight-groups/${groupId}`)).data ?? {};
    if (!((group.insights ?? []) as any[]).some((i) => i.id === insightId)) {
      await call(`/ai/conversations/insight-groups/${groupId}/insights/${insightId}/assign`, { method: 'POST' });
    }
    this.logger.log(`lead insight ready on assistant ${assistantId} (group ${groupId})`);
  }

  /**
   * Extract qualification facts from a stored transcript, for calls recorded
   * before the Insight was in place. Same instructions and schema as the
   * Insight, so both paths feed the scorer identical facts.
   */
  async extractFromTranscript(orgId: string, transcript: string): Promise<Extraction> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect your Telnyx account first');

    const res = await telnyx(c.apiKey, '/ai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: TRANSCRIPT_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: EXTRACTION_INSTRUCTIONS + TRANSCRIPT_NOTE },
          { role: 'user', content: transcript.slice(0, 30_000) },
        ],
        response_format: {
          type: 'json_schema',
          json_schema: { name: 'lead_qualification', schema: EXTRACTION_JSON_SCHEMA, strict: true },
        },
      }),
    });
    const extraction = parseExtraction(res.choices?.[0]?.message?.content);
    if (!extraction) throw new AppError('UPSTREAM_ERROR', 'The AI did not return a usable qualification');
    return extraction;
  }
}

/** A Telnyx v2 API call; non-2xx becomes UPSTREAM_ERROR. Shared with in-call booking's tool setup. */
export async function telnyx(apiKey: string, path: string, init: RequestInit = {}): Promise<any> {
  let res: Response;
  try {
    res = await fetch(`${API}${path}`, {
      ...init,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    });
  } catch (e) {
    throw new AppError('UPSTREAM_ERROR', `Telnyx unreachable: ${(e as Error).message}`);
  }
  if (!res.ok) {
    throw new AppError('UPSTREAM_ERROR', `Telnyx ${init.method ?? 'GET'} ${path.split('?')[0]} failed ${res.status}: ${(await res.text()).slice(0, 300)}`);
  }
  return res.status === 204 ? {} : res.json();
}
