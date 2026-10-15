import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { EXTRACTION_INSTRUCTIONS, EXTRACTION_JSON_SCHEMA, parseExtraction, type Extraction } from './lead-scoring';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { telnyx } from './telnyx-api';

const INSIGHT_NAME = 'EstatePulse lead qualification';
const GROUP_NAME = 'EstatePulse';
const TRANSCRIPT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const TRANSCRIPT_NOTE =
  ' The transcript labels speakers by recording channel (for example "Channel 1" and "Channel 2"); ' +
  'the assistant is the speaker asking the qualification questions, and the caller is the other one.';

/**
 * Lead qualification from a call: a Telnyx conversation Insight attached to
 * the assistant scores every call, and a transcript can be classified directly
 * when the Insight did not run.
 */
@Injectable()
export class LeadInsightsService {
  private readonly logger = new Logger(LeadInsightsService.name);
  private readonly provisioned = new Set<string>();
  private readonly inflight = new Map<string, Promise<void>>();

  constructor(private readonly creds: TelnyxCredentialsService) {}

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
      .catch((error) => this.logger.warn(`lead insight setup for org ${orgId}: ${(error as Error).message}`))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async provision(apiKey: string, assistantId: string): Promise<void> {
    const call = (path: string, init: RequestInit = {}) => telnyx(apiKey, path, init);
    const insights: { id: string; name: string }[] = (await call('/ai/conversations/insights?page[size]=99')).data ?? [];
    const body = { name: INSIGHT_NAME, instructions: EXTRACTION_INSTRUCTIONS, json_schema: EXTRACTION_JSON_SCHEMA };
    const existing = insights.find((i) => i.name === INSIGHT_NAME);
    const insightId: string = existing
      ? ((await call(`/ai/conversations/insights/${existing.id}`, { method: 'PUT', body: JSON.stringify(body) })).data?.id ?? existing.id)
      : (await call('/ai/conversations/insights', { method: 'POST', body: JSON.stringify(body) })).data.id;

    const raw = await call(`/ai/assistants/${assistantId}`);
    const assistant = raw?.data ?? raw ?? {};
    let groupId: string | undefined = assistant.insight_settings?.insight_group_id;
    if (!groupId) {
      const groups: { id: string; name: string }[] = (await call('/ai/conversations/insight-groups?page[size]=99')).data ?? [];
      groupId =
        groups.find((g) => g.name === GROUP_NAME)?.id ??
        (await call('/ai/conversations/insight-groups', { method: 'POST', body: JSON.stringify({ name: GROUP_NAME }) })).data.id;
      await call(`/ai/assistants/${assistantId}`, { method: 'POST', body: JSON.stringify({ insight_settings: { insight_group_id: groupId } }) });
    }
    const group = (await call(`/ai/conversations/insight-groups/${groupId}`)).data ?? {};
    if (!((group.insights ?? []) as { id: string }[]).some((i) => i.id === insightId)) {
      await call(`/ai/conversations/insight-groups/${groupId}/insights/${insightId}/assign`, { method: 'POST' });
    }
    this.logger.log(`lead insight ready on assistant ${assistantId}`);
  }

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
        response_format: { type: 'json_schema', json_schema: { name: 'lead_qualification', schema: EXTRACTION_JSON_SCHEMA, strict: true } },
      }),
    });
    const extraction = parseExtraction(res.choices?.[0]?.message?.content);
    if (!extraction) throw new AppError('UPSTREAM_ERROR', 'The AI did not return a usable qualification');
    return extraction;
  }
}
