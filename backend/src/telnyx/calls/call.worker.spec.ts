import { DelayedError } from 'bullmq';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CallingProviders, TelnyxCallingProvider } from '@/calling/calling-providers';
import { CallWorker, isCapacityError } from './call.worker';

const ORG = 'org-1';
const LEAD = 'lead-1';

function setup(overrides: { lead?: Record<string, unknown> | null; slot?: boolean; quietUntil?: Date; placeCall?: () => Promise<unknown> } = {}) {
  const lead = overrides.lead === undefined ? { phone: '+12895550100', status: 'contacting', dncStatus: false, automationPaused: false } : overrides.lead;
  const prisma = {
    lead: { findUnique: vi.fn().mockResolvedValue(lead) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ maxConcurrentCalls: 2 }) },
  };
  const config = { get: vi.fn() };
  const followup = { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC', quiet: undefined }) };
  const voice = { placeCall: vi.fn(overrides.placeCall ?? (() => Promise.resolve({ call_control_id: 'ccid-1' }))) };
  const activity = { startCall: vi.fn(), recordCallFailed: vi.fn() };
  const slots = {
    acquire: vi.fn().mockResolvedValue(overrides.slot ?? true),
    rename: vi.fn(),
    release: vi.fn(),
  };
  // RETELL_ENABLED off: the real registry hands the call to the real Telnyx wrapper, which hands it to `voice`.
  const providers = new CallingProviders({ get: () => undefined } as any, {} as any, new TelnyxCallingProvider(voice as any, {} as any, {} as any), {} as any);
  const worker = new CallWorker(prisma as any, config as any, followup as any, providers, activity as any, slots as any);
  const job = { id: 'job-1', name: 'dial', data: { orgId: ORG, leadId: LEAD, source: 'strategy' }, moveToDelayed: vi.fn() };
  return { worker, job, prisma, voice, activity, slots };
}

vi.mock('@/common/utils/quiet-hours', () => ({ nextAllowedAt: (_tz: string, _q: unknown, now: Date) => now }));

describe('CallWorker', () => {
  beforeEach(() => vi.clearAllMocks());

  it('dials within a free slot, then keys the slot by the call id', async () => {
    const { worker, job, voice, slots, activity } = setup();
    await worker.process(job as any, 'tok');
    expect(slots.acquire).toHaveBeenCalledWith(ORG, 'job-1', 2);
    expect(voice.placeCall).toHaveBeenCalledWith(ORG, '+12895550100', { leadId: LEAD, orgId: ORG });
    expect(slots.rename).toHaveBeenCalledWith(ORG, 'job-1', 'ccid-1');
    expect(activity.startCall).toHaveBeenCalledWith(ORG, LEAD, 'ccid-1', 'telnyx');
  });

  it('waits without dialing when the org is at its limit', async () => {
    const { worker, job, voice } = setup({ slot: false });
    await expect(worker.process(job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(job.moveToDelayed).toHaveBeenCalledOnce();
    expect(voice.placeCall).not.toHaveBeenCalled();
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
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, expect.stringContaining('invalid number'), 'telnyx');
  });

  it('frees the slot and waits when Telnyx is at capacity', async () => {
    const { worker, job, slots, activity } = setup({ placeCall: () => Promise.reject(new Error('Telnyx POST /calls failed 429: too many requests')) });
    await expect(worker.process(job as any, 'tok')).rejects.toBeInstanceOf(DelayedError);
    expect(slots.release).toHaveBeenCalledWith(ORG, 'job-1');
    expect(activity.recordCallFailed).not.toHaveBeenCalled();
  });
});

describe('CallWorker with a non-Telnyx provider', () => {
  it('dials through the organization’s provider and labels the call with it', async () => {
    const { job, prisma, activity, slots } = setup();
    const retell = { name: 'retell', capabilities: { sms: false }, startCall: vi.fn().mockResolvedValue({ providerCallId: 'call_abc' }) };
    const worker = new CallWorker(prisma as any, { get: vi.fn() } as any, { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC' }) } as any, { for: vi.fn().mockResolvedValue(retell) } as any, activity as any, slots as any);
    await worker.process(job as any, 'tok');
    expect(retell.startCall).toHaveBeenCalledWith(ORG, '+12895550100', { leadId: LEAD, orgId: ORG });
    expect(slots.rename).toHaveBeenCalledWith(ORG, 'job-1', 'call_abc');
    expect(activity.startCall).toHaveBeenCalledWith(ORG, LEAD, 'call_abc', 'retell');
  });

  it('labels a refused call with that provider', async () => {
    const { job, prisma, activity, slots } = setup();
    const retell = { name: 'retell', capabilities: { sms: false }, startCall: vi.fn().mockRejectedValue(new Error('Retell POST /v2/create-phone-call failed 402: trial ended')) };
    const worker = new CallWorker(prisma as any, { get: vi.fn() } as any, { guardrailsFor: vi.fn().mockResolvedValue({ timeZone: 'UTC' }) } as any, { for: vi.fn().mockResolvedValue(retell) } as any, activity as any, slots as any);
    await worker.process(job as any, 'tok');
    expect(slots.release).toHaveBeenCalledWith(ORG, 'job-1');
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, expect.stringContaining('trial ended'), 'retell');
  });
});

describe('isCapacityError', () => {
  it('tells capacity rejections from real failures', () => {
    expect(isCapacityError('Telnyx POST /calls failed 429: slow down')).toBe(true);
    expect(isCapacityError('Channel limit exceeded')).toBe(true);
    expect(isCapacityError('Telnyx POST /calls failed 422: invalid number')).toBe(false);
  });
});
