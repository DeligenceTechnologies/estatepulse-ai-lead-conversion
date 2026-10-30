import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/**
 * Who picked up decides how an AI call opens. A person (Telnyx's
 * answering-machine verdict, or no verdict within AI_OPENING_WAIT_MS) gets
 * the assistant, exactly once. A machine never does: it gets the voicemail
 * message after its greeting, or a hangup when voicemail is off.
 */
describe('ActivityService call opening', () => {
  const plan = { apiKey: 'KEY', assistantId: 'assistant-1', record: false, variables: { first_name: 'Ana' } };
  const CALL = { id: 'call-1', orgId: 'org-1', leadId: 'lead-1', status: 'in_progress', endedAt: null };
  let actions: { name: string; body: any }[];
  let refuse: (name: string, body: any) => boolean;

  const make = (opts: { waitMs?: number; voicemail?: boolean; voice?: string | null; call?: object | null } = {}) => {
    const config = { get: vi.fn(() => opts.waitMs ?? 5000) };
    const prisma = {
      call: {
        findFirst: vi.fn(async () => (opts.call === undefined ? CALL : opts.call)),
        update: vi.fn(async () => ({})),
      },
    };
    const creds = { getCreds: vi.fn(async () => ({ apiKey: 'KEY' })) };
    const assistants = { voiceFor: vi.fn(async () => (opts.voice === undefined ? 'Telnyx.Ultra.v1' : opts.voice)) };
    const state = { quietly: vi.fn() };
    const voicemail = {
      settings: vi.fn(async () => ({ enabled: opts.voicemail ?? true, message: 'Hi {{firstName}}, this is {{brokerage}}. Text us back!' })),
    };
    const service = new ActivityService(prisma as any, creds as any, {} as any, assistants as any, {} as any, config as any, state as any, voicemail as any, {} as any);
    service.leadVariables = vi.fn(async () => ({ firstName: 'Ana', brokerage: 'Sunny Homes' }));
    return { service, prisma, state };
  };
  const attach = (s: ActivityService) => (s as any).attach('cc-1', plan) as Promise<void>;
  const names = () => actions.map((a) => a.name);
  const count = (name: string) => names().filter((n) => n === name).length;
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    actions = [];
    refuse = () => false;
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: { body: string }) => {
      const name = String(url).split('/actions/')[1];
      const body = JSON.parse(init.body);
      actions.push({ name, body });
      const ok = !refuse(name, body);
      return { ok, status: ok ? 200 : 422, text: async () => '' };
    }));
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  describe('a person', () => {
    it('waits for the verdict instead of starting the assistant', async () => {
      const { service } = make();
      await attach(service);
      expect(names()).toEqual([]);
    });

    it('starts the assistant when Telnyx says a person answered, once', async () => {
      const { service } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', 'human_residence');
      await service.onMachineDetection('cc-1', 'human_residence');
      vi.advanceTimersByTime(6000);
      await flush();
      expect(count('ai_assistant_start')).toBe(1);
    });

    it.each(['human_business', 'not_sure', 'silence'])('treats %s as a person', async (verdict) => {
      const { service } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', verdict);
      expect(count('ai_assistant_start')).toBe(1);
    });

    it('starts the assistant by itself when no verdict comes within the wait', async () => {
      const { service } = make();
      await attach(service);
      vi.advanceTimersByTime(4999);
      await flush();
      expect(count('ai_assistant_start')).toBe(0);
      vi.advanceTimersByTime(1);
      await flush();
      expect(count('ai_assistant_start')).toBe(1);
    });

    it('keeps a verdict that arrived before the answer was handled', async () => {
      const { service } = make();
      await service.onMachineDetection('cc-1', 'human_residence');
      await attach(service);
      expect(names()).toEqual(['ai_assistant_start']);
    });

    it('never starts the assistant once the call has hung up', async () => {
      const { service } = make({ call: null });
      await attach(service);
      await service.onCallHangup('cc-1');
      vi.advanceTimersByTime(6000);
      await flush();
      expect(count('ai_assistant_start')).toBe(0);
    });

    it('a callback call opens with its own greeting', async () => {
      const { service } = make({ waitMs: 0 });
      await (service as any).attach('cc-1', { ...plan, greeting: 'Hi Ana, calling you back as you asked.' });
      expect(actions).toEqual([
        { name: 'ai_assistant_start', body: { assistant: { id: 'assistant-1' }, dynamic_variables: plan.variables, greeting: 'Hi Ana, calling you back as you asked.' } },
      ]);
    });

    it('starts at once when the wait is switched off (0)', async () => {
      const { service } = make({ waitMs: 0 });
      await attach(service);
      expect(names()).toEqual(['ai_assistant_start']);
    });
  });

  describe('recording notice', () => {
    const announced = { ...plan, record: true, announce: true, voice: 'Telnyx.Ultra.v1' };
    const NOTICE = { name: 'speak', body: { payload: 'Just so you know, this call is recorded for quality and training.', voice: 'Telnyx.Ultra.v1' } };

    it('is played first; the recording and then the assistant start only once it has been heard', async () => {
      const { service } = make({ waitMs: 0 });
      await (service as any).attach('cc-1', announced);
      expect(actions).toEqual([NOTICE]);
      await service.onSpeakEnded('cc-1', 'completed');
      expect(names()).toEqual(['speak', 'record_start', 'ai_assistant_start']);
      await service.onSpeakEnded('cc-1', 'completed');
      expect(count('record_start')).toBe(1);
    });

    it('waits for a person like the assistant does: nothing plays or records before the verdict', async () => {
      const { service } = make();
      await (service as any).attach('cc-1', announced);
      expect(names()).toEqual([]);
      await service.onMachineDetection('cc-1', 'human_residence');
      expect(names()).toEqual(['speak']);
    });

    it('a notice cut short is not followed by a recording, but the assistant still talks', async () => {
      const { service } = make({ waitMs: 0 });
      await (service as any).attach('cc-1', announced);
      await service.onSpeakEnded('cc-1', 'call_hangup');
      expect(names()).toEqual(['speak', 'ai_assistant_start']);
    });

    it('a lost speak-ended webhook does not hold the call: it goes on after the notice time', async () => {
      const { service } = make({ waitMs: 0 });
      await (service as any).attach('cc-1', announced);
      vi.advanceTimersByTime(12_000);
      await flush();
      expect(names()).toEqual(['speak', 'record_start', 'ai_assistant_start']);
    });

    it('a machine found while the notice plays gets neither a recording nor the assistant', async () => {
      const { service } = make();
      await (service as any).attach('cc-1', announced);
      vi.advanceTimersByTime(5000);
      await flush();
      await service.onMachineDetection('cc-1', 'machine');
      await service.onSpeakEnded('cc-1', 'completed');
      expect(count('record_start')).toBe(0);
      expect(count('ai_assistant_start')).toBe(0);
    });

    it('without announcing, the call records from the pick-up', async () => {
      const { service } = make({ waitMs: 0 });
      await (service as any).attach('cc-1', { ...plan, record: true, announce: false });
      expect(names()).toEqual(['record_start', 'ai_assistant_start']);
    });
  });

  describe('an answering machine', () => {
    it('never hears the assistant: the message is left after the beep, then the call ends', async () => {
      const { service, prisma, state } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { disposition: 'voicemail' } });
      expect(names()).toEqual([]);

      await service.onGreetingEnded('cc-1');
      expect(actions).toEqual([{ name: 'speak', body: { payload: 'Hi Ana, this is Sunny Homes. Text us back!', voice: 'Telnyx.Ultra.v1' } }]);

      await service.onSpeakEnded('cc-1', 'completed');
      expect(names()).toEqual(['speak', 'hangup']);
      expect(count('ai_assistant_start')).toBe(0);
      expect(state.quietly).toHaveBeenCalledWith(expect.objectContaining({ type: 'voicemail_left', callId: 'call-1' }));
    });

    it('a machine the wait mistook for a person: the assistant is stopped at the verdict', async () => {
      const { service } = make();
      await attach(service);
      vi.advanceTimersByTime(5000);
      await flush();
      await service.onMachineDetection('cc-1', 'machine');
      expect(names()).toEqual(['ai_assistant_start', 'ai_assistant_stop']);
    });

    it('a beep before the verdict: Telnyx sends only greeting.ended, and the message still goes', async () => {
      const { service } = make();
      await attach(service);
      await service.onGreetingEnded('cc-1');
      expect(names()).toEqual(['speak']);
      await service.onMachineDetection('cc-1', 'machine');
      expect(names()).toEqual(['speak']);
    });

    it('a beep while the verdict is still being handled is not missed', async () => {
      const { service } = make();
      await attach(service);
      const verdict = service.onMachineDetection('cc-1', 'machine');
      const greeting = service.onGreetingEnded('cc-1');
      await Promise.all([verdict, greeting]);
      expect(count('speak')).toBe(1);
    });

    it('with voicemail off, hangs up at the verdict', async () => {
      const { service } = make({ voicemail: false });
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      expect(names()).toEqual(['hangup']);
    });

    it("a call step's own choice wins over the organization's voicemail setting, both ways", async () => {
      const off = make({ voicemail: false });
      await attach(off.service);
      await off.service.onMachineDetection('cc-1', 'machine', { voicemail: 'leave' });
      await off.service.onGreetingEnded('cc-1', { voicemail: 'leave' });
      expect(names()).toEqual(['speak']);

      actions = [];
      const on = make({ voicemail: true });
      await attach(on.service);
      await on.service.onMachineDetection('cc-1', 'machine', { voicemail: 'skip' });
      expect(names()).toEqual(['hangup']);
    });

    it('a fax is hung up without a message', async () => {
      const { service, prisma } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', 'fax_detected');
      expect(names()).toEqual(['hangup']);
      expect(prisma.call.update).not.toHaveBeenCalled();
    });

    it("falls back to a stock voice when the assistant's voice cannot speak", async () => {
      const { service } = make();
      refuse = (name, body) => name === 'speak' && body.voice === 'Telnyx.Ultra.v1';
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      await service.onGreetingEnded('cc-1');
      expect(actions.map((a) => a.body.voice ?? a.name)).toEqual(['Telnyx.Ultra.v1', 'AWS.Polly.Joanna-Neural']);
    });

    it('hangs up without a message when speaking fails entirely', async () => {
      const { service, state } = make({ voice: null });
      refuse = (name) => name === 'speak';
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      await service.onGreetingEnded('cc-1');
      expect(names()).toEqual(['speak', 'hangup']);
      expect(state.quietly).not.toHaveBeenCalled();
    });

    it('hangs up when the end of the greeting never arrives', async () => {
      const { service } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      vi.advanceTimersByTime(35_000);
      await flush();
      expect(names()).toEqual(['hangup']);
    });

    it('hangs up when the message never reports that it finished', async () => {
      const { service, state } = make();
      await attach(service);
      await service.onMachineDetection('cc-1', 'machine');
      await service.onGreetingEnded('cc-1');
      vi.advanceTimersByTime(60_000);
      await flush();
      expect(names()).toEqual(['speak', 'hangup']);
      expect(state.quietly).not.toHaveBeenCalled();
    });
  });
});
