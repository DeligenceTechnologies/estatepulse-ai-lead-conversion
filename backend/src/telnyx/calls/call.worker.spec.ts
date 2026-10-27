import { DelayedError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { callIntent } from './call.types';
import { CallWorker, REDIAL_GAP_MS, isCapacityError, isInvalidNumberError, isTransientDialError } from './call.worker';

const ORG = 'org-1';
const LEAD = 'lead-1';

function setup(overrides: { lead?: Record<string, unknown> | null; slot?: boolean; quietUntil?: Date; placeCall?: () => Promise<unknown>; liveCalls?: number; lastCall?: Record<string, unknown> } = {}) {
  const lead = overrides.lead === undefined ? { phone: '+12895550100', status: 'contacting', dncStatus: false, automationPaused: false } : overrides.lead;
  const prisma = {
    lead: { findUnique: vi.fn().mockResolvedValue(lead) },
    call: {
      count: vi.fn().mockResolvedValue(overrides.liveCalls ?? 0),
      findFirst: vi.fn().mockResolvedValue(overrides.lastCall ?? null),
    },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ maxConcurrentCalls: 2 }) },
  };
  const config = { get: vi.fn() };
  const followup = { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC', quiet: undefined }) };
  const voice = { placeCall: vi.fn(overrides.placeCall ?? (() => Promise.resolve({ call_control_id: 'ccid-1' }))) };
  const activity = { startCall: vi.fn(), recordCallFailed: vi.fn(), markInvalid: vi.fn() };
  const slots = {
    acquire: vi.fn().mockResolvedValue(overrides.slot ?? true),
    rename: vi.fn(),
    release: vi.fn(),
  };
  const worker = new CallWorker(prisma as any, config as any, followup as any, voice as any, activity as any, slots as any);
  const job = { id: 'job-1', name: 'dial', data: { orgId: ORG, leadId: LEAD, source: 'strategy' } as Record<string, unknown>, moveToDelayed: vi.fn(), updateData: vi.fn() };
  return { worker, job, prisma, voice, activity, slots };
}

vi.mock('@/common/utils/quiet-hours', () => ({
  nextAllowedAt: (_tz: string, _q: unknown, now: Date) => now,
  nextContactAt: (_tz: string, _q: unknown, _skip: unknown, now: Date) => now,
}));

describe('CallWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dials within a free slot, then keys the slot by the call id', async () => {
    const { worker, job, voice, slots, activity } = setup();
    await worker.process(job as any, 'tok');
    expect(slots.acquire).toHaveBeenCalledWith(ORG, 'job-1', 2);
    expect(voice.placeCall).toHaveBeenCalledWith(ORG, '+12895550100', { leadId: LEAD, orgId: ORG });
    expect(activity.startCall).toHaveBeenCalledWith(ORG, LEAD, 'ccid-1', {});
    expect(slots.rename).toHaveBeenCalledWith(ORG, 'job-1', 'ccid-1');
  });

  it('waits without dialing when the org is at its limit', async () => {
    const { worker, job, voice } = setup({ slot: false });
    await expect(worker.process(job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(voice.placeCall).not.toHaveBeenCalled();
  });

  it("passes the step's voicemail choice and call context to the call, through client_state", async () => {
    const { worker, job, voice, activity } = setup();
    job.data = { ...job.data, voicemail: 'skip', context: 'Second try; mention the open house' };
    await worker.process(job as any, 'tok');
    const intent = { voicemail: 'skip', context: 'Second try; mention the open house' };
    expect(voice.placeCall).toHaveBeenCalledWith(ORG, '+12895550100', { leadId: LEAD, orgId: ORG, ...intent });
    expect(activity.startCall).toHaveBeenCalledWith(ORG, LEAD, 'ccid-1', intent);
  });

  describe('a callback', () => {
    const AT = '2026-10-28T11:30:00.000Z';
    const callbackJob = (job: any) => ({ ...job, data: { ...job.data, source: 'callback', callbackAt: AT } });

    it('dials a hot lead too: the AI promised the callback', async () => {
      const { worker, job, voice } = setup({ lead: { phone: '+1', status: 'interested', dncStatus: false, automationPaused: false, callbackAt: new Date(AT) } });
      await worker.process(callbackJob(job), 'tok');
      expect(voice.placeCall).toHaveBeenCalled();
    });

    it('is dropped once the lead moved or cleared the callback', async () => {
      for (const callbackAt of [null, new Date('2026-10-29T11:30:00.000Z')]) {
        const { worker, job, voice } = setup({ lead: { phone: '+1', status: 'follow_up', dncStatus: false, automationPaused: false, callbackAt } });
        await worker.process(callbackJob(job), 'tok');
        expect(voice.placeCall).not.toHaveBeenCalled();
      }
    });

    it('waits while the lead is still on our previous call', async () => {
      const { worker, job, voice } = setup({ liveCalls: 1, lead: { phone: '+1', status: 'follow_up', dncStatus: false, automationPaused: false, callbackAt: new Date(AT) } });
      const cb = callbackJob(job);
      await expect(worker.process(cb, 'tok')).rejects.toBeInstanceOf(DelayedError);
      expect(cb.moveToDelayed).toHaveBeenCalledOnce();
      expect(voice.placeCall).not.toHaveBeenCalled();
    });

    it('is dropped for a booked lead', async () => {
      const { worker, job, voice } = setup({ lead: { phone: '+1', status: 'appointment_booked', dncStatus: false, automationPaused: false, callbackAt: new Date(AT) } });
      await worker.process(callbackJob(job), 'tok');
      expect(voice.placeCall).not.toHaveBeenCalled();
    });

    it('an ordinary call to a hot lead is still dropped', async () => {
      const { worker, job, voice } = setup({ lead: { phone: '+1', status: 'interested', dncStatus: false, automationPaused: false, callbackAt: null } });
      await worker.process(job as any, 'tok');
      expect(voice.placeCall).not.toHaveBeenCalled();
    });
  });

  describe('redials', () => {
    it('waits 30 minutes after the lead declined or was busy', async () => {
      for (const disposition of ['busy', 'rejected']) {
        const endedAt = new Date(Date.now() - 5 * 60_000);
        const { worker, job, voice } = setup({ lastCall: { disposition, endedAt } });
        await expect(worker.process(job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
        expect(job.moveToDelayed).toHaveBeenCalledWith(endedAt.getTime() + REDIAL_GAP_MS, 'tok');
        expect(voice.placeCall).not.toHaveBeenCalled();
      }
    });

    it('dials once the gap has passed, or after a call that was simply not answered', async () => {
      for (const lastCall of [{ disposition: 'busy', endedAt: new Date(Date.now() - 31 * 60_000) }, { disposition: 'no_answer', endedAt: new Date() }]) {
        const { worker, job, voice } = setup({ lastCall });
        await worker.process(job as any, 'tok');
        expect(voice.placeCall).toHaveBeenCalled();
      }
    });

    it('a failure on Telnyx\'s side is retried once after 10 minutes, then recorded', async () => {
      const failing = () => Promise.reject(new Error('Telnyx POST /calls failed 503: Service Unavailable'));
      const first = setup({ placeCall: failing });
      await expect(first.worker.process(first.job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
      expect(first.job.updateData).toHaveBeenCalledWith(expect.objectContaining({ dialRetried: true }));
      expect(first.activity.recordCallFailed).not.toHaveBeenCalled();
      expect(first.slots.release).toHaveBeenCalled();

      const second = setup({ placeCall: failing });
      second.job.data = { ...second.job.data, dialRetried: true };
      await second.worker.process(second.job as any, 'tok');
      expect(second.activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, expect.stringContaining('503'), 'failed');
    });

    it('a refused account or a bad request is not retried', () => {
      expect(isTransientDialError('Telnyx POST /calls failed 403: Account is disabled D17')).toBe(false);
      expect(isTransientDialError('Telnyx POST /calls failed 422: invalid number')).toBe(false);
      expect(isTransientDialError('Telnyx unreachable: The operation was aborted due to timeout')).toBe(true);
    });
  });

  it('drops the call when the lead opted out while it was queued', async () => {
    const { worker, job, voice, slots } = setup({ lead: { phone: '+1', status: 'contacting', dncStatus: true, automationPaused: false } });
    await worker.process(job as any, 'tok');
    expect(slots.acquire).not.toHaveBeenCalled();
    expect(voice.placeCall).not.toHaveBeenCalled();
  });

  it('frees the slot and records a failed call when Telnyx rejects the call', async () => {
    const { worker, job, slots, activity } = setup({ placeCall: () => Promise.reject(new Error('Telnyx POST /calls failed 422: invalid number')) });
    await worker.process(job as any, 'tok');
    expect(slots.release).toHaveBeenCalledWith(ORG, 'job-1');
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, expect.stringContaining('invalid number'), 'failed');
    expect(activity.markInvalid).not.toHaveBeenCalled();
  });

  it('marks the lead invalid when Telnyx says the number does not exist (D50)', async () => {
    // The body Telnyx returned on 2026-10-26 for a dial to +1 289 555 0142.
    const d50 =
      'Telnyx POST /calls failed 403: {"data":{"call_control_id":"v3:abc"},"errors":[{"code":"10010","title":null,' +
      '"detail":"The destination number is invalid D50. The destination number is a US/CA number that does not have a valid LRN."}]}';
    const { worker, job, activity } = setup({ placeCall: () => Promise.reject(new Error(d50)) });
    await worker.process(job as any, 'tok');
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, d50, 'invalid_number');
    expect(activity.markInvalid).toHaveBeenCalledWith(LEAD, expect.stringContaining('D50'));
  });

  it('frees the slot and waits when Telnyx is at capacity', async () => {
    const { worker, job, slots, activity } = setup({ placeCall: () => Promise.reject(new Error('Telnyx POST /calls failed 429: too many requests')) });
    await expect(worker.process(job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(slots.release).toHaveBeenCalledWith(ORG, 'job-1');
    expect(activity.recordCallFailed).not.toHaveBeenCalled();
  });
});

describe('isCapacityError', () => {
  it('tells capacity rejections from real failures', () => {
    expect(isCapacityError('Telnyx POST /calls failed 429: slow down')).toBe(true);
    expect(isCapacityError('Channel limit exceeded')).toBe(true);
    expect(isCapacityError('Telnyx POST /calls failed 422: invalid number')).toBe(false);
  });
});

describe('isInvalidNumberError', () => {
  it('matches only the dial rejection for a number that does not exist', () => {
    expect(isInvalidNumberError('failed 403: {"errors":[{"code":"10010","detail":"The destination number is invalid D50."}]}')).toBe(true);
    expect(isInvalidNumberError('Telnyx POST /calls failed 429: too many requests')).toBe(false);
    expect(isInvalidNumberError('Telnyx POST /calls failed 403: D13 destination not allowed by your outbound profile')).toBe(false);
  });
});

describe('callIntent', () => {
  const encode = (o: unknown) => Buffer.from(JSON.stringify(o)).toString('base64');

  it("reads a step's choices back from a webhook's client_state", () => {
    expect(callIntent(encode({ leadId: 'l', orgId: 'o', voicemail: 'leave', context: ' Follow up on the open house ' }))).toEqual({
      voicemail: 'leave',
      context: 'Follow up on the open house',
    });
  });

  it('ignores anything it does not know, or cannot read', () => {
    expect(callIntent(encode({ voicemail: 'shout', context: 42 }))).toEqual({});
    expect(callIntent('not base64 json')).toEqual({});
    expect(callIntent(undefined)).toEqual({});
  });
});
