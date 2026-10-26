import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CallingProviders, TelnyxCallingProvider } from '@/calling/calling-providers';
import { inQuietHours } from '@/common/utils/quiet-hours';
import { EngineService, remainingSteps } from './engine.service';
import type { StrategyStep } from './strategy-store.service';

/** Characterization: what each strategy step sends, and what holds it back. */

vi.mock('@/common/utils/quiet-hours', async (original) => ({
  ...(await original<typeof import('@/common/utils/quiet-hours')>()),
  inQuietHours: vi.fn(() => false),
  deferredResume: vi.fn(({ now }: { now: number }) => ({ shift: 0, resumeAt: now + 3_600_000 })),
}));

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-23T15:00:00Z');

const steps: StrategyStep[] = [
  { id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'sms', message: 'Hi {{firstName}}, this is {{brokerage}}. {{firstName}}?' },
  { id: 's2', after: { value: 1, unit: 'minutes' }, channel: 'voice' },
  { id: 's3', after: { value: 2, unit: 'minutes' }, channel: 'voice' },
];

function setup(lead: Record<string, unknown> = {}) {
  const live = { id: LEAD, orgId: ORG, firstName: ' Asha ', phone: '+12895550111', status: 'contacting', dncStatus: false, automationPaused: false, ...lead };
  const tx = { lead: { updateMany: vi.fn().mockResolvedValue({ count: 1 }) } };
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue({ ...live, dncStatus: false, automationPaused: false }), findUnique: vi.fn().mockResolvedValue(live) },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty', settings: { timezone: 'UTC' } }) },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const strategies = {
    getStrategy: vi.fn().mockResolvedValue({ name: 'Default', guardrails: { respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 1 }, steps }),
  };
  const sms = { sendSms: vi.fn().mockResolvedValue({ id: 'msg-1' }) };
  const calls = { enqueue: vi.fn().mockResolvedValue('job-1') };
  const activity = { recordSms: vi.fn(), recordCallFailed: vi.fn(), exitStrategy: vi.fn() };
  const followup = { sequenceForTrigger: vi.fn(), enroll: vi.fn(), stopForLead: vi.fn() };
  // RETELL_ENABLED off: the real registry hands the text to the real Telnyx wrapper, which hands it to `sms`.
  const providers = new CallingProviders({ get: () => undefined } as any, {} as any, new TelnyxCallingProvider({} as any, sms as any, {} as any), {} as any);
  const engine = new EngineService(prisma as any, strategies as any, providers, calls as any, activity as any, followup as any);
  return { engine, prisma, strategies, sms, calls, activity };
}

describe('EngineService steps', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
    vi.setSystemTime(NOW);
    vi.mocked(inQuietHours).mockReturnValue(false);
  });
  afterEach(() => vi.useRealTimers());

  it('texts the templated message through Telnyx SMS and records it', async () => {
    const { engine, sms, activity } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(sms.sendSms).toHaveBeenCalledWith(ORG, '+12895550111', 'Hi Asha, this is Acme Realty. Asha?');
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, 'Hi Asha, this is Acme Realty. Asha?', true, 'msg-1');
  });

  it('records the failure when the text cannot be sent', async () => {
    const { engine, sms, activity } = setup();
    sms.sendSms.mockRejectedValue(new Error('No provider connected'));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(activity.recordSms).toHaveBeenCalledWith(ORG, LEAD, expect.any(String), false, 'No provider connected');
  });

  it('queues a voice step once per attempt, up to the max, keyed so a retry never dials twice', async () => {
    const { engine, calls } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(calls.enqueue).toHaveBeenCalledOnce();
    expect(calls.enqueue).toHaveBeenCalledWith({ orgId: ORG, leadId: LEAD, source: 'strategy' }, { dedupeKey: `strategy:${LEAD}:${NOW.getTime()}:1` });
  });

  it('records a failed call when the queue refuses the job', async () => {
    const { engine, calls, activity } = setup();
    calls.enqueue.mockRejectedValue(new Error('The call queue is unavailable'));
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(activity.recordCallFailed).toHaveBeenCalledWith(ORG, LEAD, 'The call queue is unavailable', 'telnyx');
  });

  it('holds every step during quiet hours', async () => {
    vi.mocked(inQuietHours).mockReturnValue(true);
    const { engine, sms, calls } = setup();
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(calls.enqueue).not.toHaveBeenCalled();
  });

  it('skips SMS steps for a provider without SMS, never calling it, and still runs the voice steps', async () => {
    const { prisma, strategies, calls, activity } = setup() as any;
    const noSms = { name: 'retell', capabilities: { sms: false }, sendSms: vi.fn() };
    const providers = { for: vi.fn().mockResolvedValue(noSms), nameFor: vi.fn().mockResolvedValue('retell') };
    const followup = { sequenceForTrigger: vi.fn(), enroll: vi.fn(), stopForLead: vi.fn() };
    const engine = new EngineService(prisma, strategies, providers as any, calls, activity, followup as any);
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(noSms.sendSms).not.toHaveBeenCalled();
    expect(activity.recordSms).not.toHaveBeenCalled();
    expect(calls.enqueue).toHaveBeenCalledOnce();
  });

  it('stops when the lead opted out before the step ran', async () => {
    const { engine, sms } = setup({ dncStatus: true });
    await engine.enroll(ORG, LEAD);
    await vi.advanceTimersByTimeAsync(3 * 60_000);
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(engine.isRunning(LEAD)).toBe(false);
  });
});

describe('remainingSteps', () => {
  it('skips the calls and texts already on record and keeps the spacing', () => {
    const enrolledAt = 1_000_000;
    const { remaining, anchor } = remainingSteps(steps, 1, 1, enrolledAt, enrolledAt + 2 * 60_000);
    expect(remaining.map((s) => s.id)).toEqual(['s3']);
    expect(anchor).toBe(enrolledAt);
    expect(remainingSteps(steps, 0, 0, enrolledAt, enrolledAt + 5 * 60_000).anchor).toBe(enrolledAt + 5 * 60_000);
  });
});
