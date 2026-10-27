import 'reflect-metadata';
import { plainToInstance } from 'class-transformer';
import { describe, expect, it, vi } from 'vitest';
import { StrategyDto } from './dto/telnyx.dto';
import { StrategyStoreService, defaultStrategy, stepOffsets } from './strategy-store.service';

function store(saved: unknown) {
  const prisma = {
    organizationSetting: {
      findUnique: vi.fn(async () => (saved === undefined ? null : { outreachStrategy: saved })),
      upsert: vi.fn(async () => ({})),
    },
  };
  return { service: new StrategyStoreService(prisma as any), prisma };
}

const STEPS = [{ id: 's1', channel: 'sms', after: { value: 0, unit: 'minutes' }, message: 'hi' }];

describe('StrategyStoreService', () => {
  it('saving only the steps keeps the guardrails and name (the DTO carries unset fields as undefined)', async () => {
    const { service, prisma } = store(defaultStrategy());
    const body = plainToInstance(StrategyDto, { steps: STEPS });
    expect(Object.keys(body)).toContain('guardrails');

    await service.saveStrategy('org-1', body as any);
    const saved = (prisma.organizationSetting.upsert.mock.calls[0] as any)[0].update.outreachStrategy;
    expect(saved.steps).toEqual(STEPS);
    expect(saved.name).toBe(defaultStrategy().name);
    expect(saved.guardrails.quietHours).toEqual({ start: '21:00', end: '08:00' });
  });

  it('fills in what a saved strategy lost, without overriding what it has', async () => {
    const lost = await store({ steps: STEPS }).service.getStrategy('org-1');
    expect(lost.steps).toEqual(STEPS);
    expect(lost.guardrails.quietHours).toEqual({ start: '21:00', end: '08:00' });

    const off = await store({ steps: STEPS, guardrails: { respectQuietHours: false } }).service.getStrategy('org-1');
    expect(off.guardrails.respectQuietHours).toBe(false);
  });

  it('keeps a strategy whose steps were all removed', async () => {
    expect((await store({ steps: [] }).service.getStrategy('org-1')).steps).toEqual([]);
  });
});

describe('stepOffsets', () => {
  it('adds each wait to the ones before it', () => {
    expect(stepOffsets(defaultStrategy().steps)).toEqual([0, 60_000, 6 * 60_000]);
    expect(
      stepOffsets([
        { id: 'a', channel: 'sms', after: { value: 2, unit: 'hours' } },
        { id: 'b', channel: 'voice', after: { value: 30, unit: 'seconds' } },
        { id: 'c', channel: 'sms', after: { value: 1, unit: 'days' } },
      ]),
    ).toEqual([7_200_000, 7_230_000, 93_630_000]);
  });

  it('keeps a step\'s options only where they mean something', async () => {
    const { service, prisma } = store(defaultStrategy());
    await service.saveStrategy('org-1', {
      steps: [
        { id: 'a', channel: 'sms', after: { value: 0, unit: 'minutes' }, message: 'hi', voicemail: 'leave', context: 'x', onlyIf: { lastCallMissed: false, noReply: true } },
        { id: 'b', channel: 'voice', after: { value: 5, unit: 'minutes' }, voicemail: 'default', context: '  ' },
        { id: 'c', channel: 'voice', after: { value: 1, unit: 'days' }, voicemail: 'skip', context: ' Second try ', onlyIf: { lastCallMissed: true } },
      ],
    } as any);
    const saved = (prisma.organizationSetting.upsert.mock.calls[0] as any)[0].update.outreachStrategy;
    expect(saved.steps).toEqual([
      { id: 'a', channel: 'sms', after: { value: 0, unit: 'minutes' }, message: 'hi' },
      { id: 'b', channel: 'voice', after: { value: 5, unit: 'minutes' } },
      { id: 'c', channel: 'voice', after: { value: 1, unit: 'days' }, voicemail: 'skip', context: 'Second try', onlyIf: { lastCallMissed: true } },
    ]);
  });

  it('keeps only the condition about the step before: none on the first, a reply after a text, an answer after a call', async () => {
    const { service, prisma } = store(defaultStrategy());
    const both = { lastCallMissed: true, noReply: true };
    await service.saveStrategy('org-1', {
      steps: [
        { id: 'a', channel: 'sms', after: { value: 0, unit: 'minutes' }, message: 'hi', onlyIf: both },
        { id: 'b', channel: 'voice', after: { value: 5, unit: 'minutes' }, onlyIf: both },
        { id: 'c', channel: 'sms', after: { value: 2, unit: 'minutes' }, message: 'tried you', onlyIf: both },
        { id: 'd', channel: 'sms', after: { value: 1, unit: 'days' }, message: 'still there?', onlyIf: { lastCallMissed: true } },
      ],
    } as any);
    const saved = (prisma.organizationSetting.upsert.mock.calls[0] as any)[0].update.outreachStrategy;
    expect(saved.steps.map((st: any) => st.onlyIf)).toEqual([undefined, { noReply: true }, { lastCallMissed: true }, undefined]);
  });

  it('checks the contact limits and skip days it is given, and keeps the other guardrails', async () => {
    const { service, prisma } = store(defaultStrategy());
    await service.saveStrategy('org-1', { guardrails: { limits: { callsPerDay: 99, smsPerDay: 4, minGapMinutes: 15 }, skipDays: [0, 0, 8] } } as any);
    const saved = (prisma.organizationSetting.upsert.mock.calls[0] as any)[0].update.outreachStrategy;
    expect(saved.guardrails.limits).toEqual({ callsPerDay: 2, smsPerDay: 4, minGapMinutes: 15 });
    expect(saved.guardrails.skipDays).toEqual([0]);
    expect(saved.guardrails.quietHours).toEqual({ start: '21:00', end: '08:00' });
  });

  it('rejects a voicemail choice it does not know', async () => {
    const { validate } = await import('class-validator');
    const body = plainToInstance(StrategyDto, { steps: [{ id: 's1', channel: 'voice', after: { value: 0, unit: 'minutes' }, voicemail: 'shout' }] });
    const errors = await validate(body);
    expect(JSON.stringify(errors)).toContain('voicemail');
  });

  it('a new organization gets the daily limits and a tried-calling text that needs a missed call', () => {
    const d = defaultStrategy();
    expect(d.guardrails.limits).toEqual({ callsPerDay: 2, smsPerDay: 3, minGapMinutes: 10 });
    expect(d.steps.find((st) => st.id === 's3')?.onlyIf).toEqual({ lastCallMissed: true });
  });
});
