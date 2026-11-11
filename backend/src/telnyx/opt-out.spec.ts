import { describe, expect, it, vi } from 'vitest';
import { telnyx } from './telnyx-api';
import { LeadScoringService } from './lead-scoring.service';
import { CallOutcomeToolController } from './tools/call-tools.controller';
import { callToolDefinitions, withCallToolsSection } from './tools/call-tools';

vi.mock('./telnyx-api', async (importOriginal) => ({ ...(await importOriginal<typeof import('./telnyx-api')>()), telnyx: vi.fn() }));

/** "Stop calling me" sets do-not-contact whatever is switched off: the call tools, the recording, or both. */
describe('a spoken opt-out', () => {
  describe('with the call tools switched off', () => {
    it('the assistant keeps one tool, record_outcome for do_not_contact only, and its prompt section', () => {
      const defs = callToolDefinitions('https://api.example.com', 'secret', false);
      expect(defs).toHaveLength(1);
      expect(defs[0].webhook).toMatchObject({ name: 'record_outcome', url: 'https://api.example.com/tools/telnyx/outcome/record' });
      expect((defs[0].webhook.body_parameters.properties as any).outcome.enum).toEqual(['do_not_contact']);
      const prompt = withCallToolsSection('# Role\nHello.', false);
      expect(prompt).toContain('do_not_contact');
      expect(prompt).not.toContain('schedule_callback');
      expect(callToolDefinitions('https://api.example.com', 'secret').map((d) => d.webhook.name)).toEqual(['schedule_callback', 'schedule_text', 'record_outcome', 'get_meeting']);
    });

    const REQ = { header: () => undefined } as any;
    const controller = (enabled: boolean) => {
      const caller = { orgId: 'org-1', leadId: 'lead-1', callId: 'call-1' };
      const outcomes = { record: vi.fn(async () => ({ ok: true })) };
      const callbacks = { schedule: vi.fn(async () => ({ ok: true })) };
      const c = new CallOutcomeToolController(
        { verify: vi.fn(async () => caller) } as any,
        { settings: vi.fn(async () => ({ enabled })), tokenHash: vi.fn() } as any,
        callbacks as any,
        outcomes as any,
        { schedule: vi.fn() } as any,
        { lookup: vi.fn() } as any,
      );
      return { c, outcomes, callbacks };
    };

    it('records the opt-out, and refuses everything else the switch turned off', async () => {
      const { c, outcomes, callbacks } = controller(false);
      await c.record(REQ, { outcome: 'do_not_contact' });
      expect(outcomes.record).toHaveBeenCalledWith(expect.anything(), { outcome: 'do_not_contact', note: undefined });
      expect(await c.record(REQ, { outcome: 'not_interested' })).toMatchObject({ ok: false, reason: 'off' });
      expect(await c.callback(REQ, {})).toMatchObject({ ok: false, reason: 'off' });
      expect(outcomes.record).toHaveBeenCalledTimes(1);
      expect(callbacks.schedule).not.toHaveBeenCalled();
    });

    it('with the switch on, every outcome goes through', async () => {
      const { c, outcomes } = controller(true);
      await c.record(REQ, { outcome: 'not_interested' });
      expect(outcomes.record).toHaveBeenCalled();
    });
  });

  describe("after the call, from the assistant's own conversation", () => {
    const make = (extractedIntel: unknown = null) => {
      const call = { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', disposition: 'connected', extractedIntel };
      const prisma = { call: { findFirst: vi.fn(async () => call) } };
      const insights = { extractFromTranscript: vi.fn(async () => ({ do_not_contact: true })) };
      const service = new LeadScoringService(
        prisma as any,
        { getCreds: vi.fn(async () => ({ apiKey: 'KEY' })) } as any,
        insights as any,
        {} as any,
        {} as any,
        {} as any,
        {} as any,
      );
      const apply = vi.fn(async () => ({}));
      (service as any).apply = apply;
      vi.mocked(telnyx).mockResolvedValue({
        data: [
          { role: 'assistant', text: 'Hi, this is an AI assistant for Maple Realty.' },
          { role: 'user', text: 'Stop calling me.' },
          { role: 'tool', text: '{}' },
        ],
      } as any);
      return { service, insights, apply };
    };

    it('scores a call nothing else analysed (no Insight, no recording), so its "stop calling me" sets do-not-contact', async () => {
      const { service, insights, apply } = make();
      await service.scoreFromConversation('cc-1', 'conv-1');
      expect(telnyx).toHaveBeenCalledWith('KEY', '/ai/conversations/conv-1/messages?page[size]=200');
      expect(insights.extractFromTranscript).toHaveBeenCalledWith('org-1', 'Assistant: Hi, this is an AI assistant for Maple Realty.\nLead: Stop calling me.');
      expect(apply).toHaveBeenCalledWith(expect.objectContaining({ id: 'call-1' }), { do_not_contact: true }, 'conversation');
    });

    it('leaves a call already scored by the Insight or the transcript alone', async () => {
      const { service, apply } = make({ qualification: { score: 10 } });
      await service.scoreFromConversation('cc-1', 'conv-1');
      expect(apply).not.toHaveBeenCalled();
    });

    it('waits after the conversation ends, then looks', () => {
      vi.useFakeTimers();
      const { service } = make();
      const spy = vi.spyOn(service, 'scoreFromConversation').mockResolvedValue(null);
      service.onConversationEnded('cc-1', { conversation_id: 'conv-1' }, 1000);
      expect(spy).not.toHaveBeenCalled();
      vi.advanceTimersByTime(1000);
      expect(spy).toHaveBeenCalledWith('cc-1', 'conv-1');
      vi.useRealTimers();
    });
  });
});
