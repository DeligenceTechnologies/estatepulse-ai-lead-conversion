import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { parseExtraction, type Extraction } from './lead-scoring';
import { extractionInstructionsFor, extractionJsonSchemaFor, questionsHash, type Question } from './qualification';
import { QualificationQuestionsService } from './qualification-questions.service';
import { TelnyxCredentialsService } from './telnyx-credentials.service';
import { telnyx } from './telnyx-api';

const INSIGHT_NAME = 'EstatePulse lead qualification';
const GROUP_NAME = 'EstatePulse';
const TRANSCRIPT_MODEL = 'meta-llama/Llama-3.3-70B-Instruct';
const TRANSCRIPT_NOTE =
  ' The transcript labels speakers by recording channel (for example "Channel 1" and "Channel 2"); ' +
  'the assistant is the speaker asking the qualification questions, and the caller is the other one.';
const CHAT_NOTE =
  ' This is a text-message chat, not a call: lines starting "Us:" are the brokerage, lines starting "Lead:" are the lead. ' +
  'Treat "caller" in these instructions as the lead. A lead who texts back has reached a person.';

/** Longest memory note kept on a lead: it goes into every call and chat prompt. */
export const MEMORY_SUMMARY_MAX = 1200;
const MEMORY_INSTRUCTIONS = [
  'You keep a short memory note about one home-buying lead for a real estate brokerage, so the AI assistant that calls and texts them never makes them repeat themselves.',
  'You get the current note and the newest conversation (a call transcript or a text chat). Write the updated note.',
  '- Keep only what helps the next conversation: their situation, preferences, constraints, objections, promises we made, when and how they want to be contacted, who else decides.',
  '- Leave out what the structured fields already hold unless there is nuance: budget, timeline, location, bedrooms and financing.',
  '- Newer facts replace older ones. Drop anything outdated.',
  `- Plain short sentences, no headings, under ${MEMORY_SUMMARY_MAX} characters. If there is nothing worth keeping, return the current note unchanged (or an empty string).`,
].join('\n');
const MEMORY_JSON_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['note'],
  properties: { note: { type: 'string', description: 'The updated memory note.' } },
} as const;

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

  constructor(
    private readonly creds: TelnyxCredentialsService,
    private readonly questions: QualificationQuestionsService,
  ) {}

  /** Once per assistant and question list: the Insight extracts this org's questions. */
  async ensureProvisioned(orgId: string): Promise<void> {
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (!c?.apiKey || !c.assistantId) return;
    const questions = await this.questions.get(orgId);
    const key = `${orgId}:${c.assistantId}:${questionsHash(questions)}`;
    if (this.provisioned.has(key)) return;
    const running = this.inflight.get(key);
    if (running) return running;
    const run = this.provision(c.apiKey, c.assistantId, questions)
      .then(() => {
        this.provisioned.add(key);
      })
      .catch((error) => this.logger.warn(`lead insight setup for org ${orgId}: ${(error as Error).message}`))
      .finally(() => this.inflight.delete(key));
    this.inflight.set(key, run);
    return run;
  }

  private async provision(apiKey: string, assistantId: string, questions: Question[]): Promise<void> {
    const call = (path: string, init: RequestInit = {}) => telnyx(apiKey, path, init);
    const insights: { id: string; name: string }[] = (await call('/ai/conversations/insights?page[size]=99')).data ?? [];
    const body = { name: INSIGHT_NAME, instructions: extractionInstructionsFor(questions), json_schema: extractionJsonSchemaFor(questions) };
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
    return this.extract(orgId, transcript, TRANSCRIPT_NOTE);
  }

  /** The same qualification from a text chat, written as "Us: ..." / "Lead: ..." lines. */
  async extractFromChat(orgId: string, chat: string): Promise<Extraction> {
    return this.extract(orgId, chat, CHAT_NOTE);
  }

  /** The lead's memory note rewritten with what the newest conversation added. */
  async rewriteMemory(orgId: string, current: string | null, conversation: string): Promise<string> {
    const c = await this.requireKey(orgId);
    const res = await telnyx(c, '/ai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: TRANSCRIPT_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: MEMORY_INSTRUCTIONS },
          { role: 'user', content: `Current note:\n${current?.trim() || '(empty)'}\n\nNewest conversation:\n${conversation.slice(-12_000)}` },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'lead_memory', schema: MEMORY_JSON_SCHEMA, strict: true } },
      }),
    });
    const raw = res.choices?.[0]?.message?.content;
    let note: unknown;
    try {
      note = (typeof raw === 'string' ? JSON.parse(raw) : raw)?.note;
    } catch {
      note = undefined;
    }
    if (typeof note !== 'string') throw new AppError('UPSTREAM_ERROR', 'The AI did not return a usable memory note');
    return note.trim().slice(0, MEMORY_SUMMARY_MAX);
  }

  private async extract(orgId: string, text: string, note: string): Promise<Extraction> {
    const apiKey = await this.requireKey(orgId);
    const questions = await this.questions.get(orgId);
    const res = await telnyx(apiKey, '/ai/chat/completions', {
      method: 'POST',
      body: JSON.stringify({
        model: TRANSCRIPT_MODEL,
        temperature: 0,
        messages: [
          { role: 'system', content: extractionInstructionsFor(questions) + note },
          { role: 'user', content: text.slice(0, 30_000) },
        ],
        response_format: { type: 'json_schema', json_schema: { name: 'lead_qualification', schema: extractionJsonSchemaFor(questions), strict: true } },
      }),
    });
    const extraction = parseExtraction(res.choices?.[0]?.message?.content);
    if (!extraction) throw new AppError('UPSTREAM_ERROR', 'The AI did not return a usable qualification');
    return extraction;
  }

  private async requireKey(orgId: string): Promise<string> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw new AppError('CONFLICT', 'Connect your Telnyx account first');
    return c.apiKey;
  }
}
