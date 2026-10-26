import { describe, expect, it, vi } from 'vitest';
import { labelSpeakers } from '@/history/history.service';
import { LeadWatcherService } from './lead-watcher.service';

/** Characterization: which organizations the strategy engine works, and how a Telnyx transcript is labelled. */

function setup(retell = false) {
  const prisma = {
    integration: { findMany: vi.fn().mockResolvedValue([{ orgId: 'org-1' }]) },
    lead: {
      findMany: vi
        .fn()
        .mockResolvedValueOnce([{ id: 'in-flight' }])
        .mockResolvedValueOnce([{ id: 'fresh' }])
        .mockResolvedValueOnce([{ id: 'stranded' }]),
    },
  };
  const engine = { resume: vi.fn(), enroll: vi.fn(), finalizeAbandoned: vi.fn() };
  const config = { get: vi.fn((key: string) => ({ STRATEGY_STALE_MS: 86_400_000, RETELL_ENABLED: retell })[key]) };
  const watcher = new LeadWatcherService(prisma as any, engine as any, config as any);
  return { poll: () => (watcher as any).poll() as Promise<void>, prisma, engine };
}

describe('LeadWatcherService.poll', () => {
  it('works only organizations with an active Telnyx account', async () => {
    const { poll, prisma } = setup();
    await poll();
    expect(prisma.integration.findMany).toHaveBeenCalledWith({
      where: { provider: 'telnyx', status: 'active' },
      select: { orgId: true },
      distinct: ['orgId'],
    });
  });

  it('with RETELL_ENABLED, also works organizations whose active calling account is Retell', async () => {
    const { poll, prisma } = setup(true);
    await poll();
    expect(prisma.integration.findMany).toHaveBeenCalledWith({
      where: { provider: { in: ['telnyx', 'retell'] }, status: 'active' },
      select: { orgId: true },
      distinct: ['orgId'],
    });
  });

  it('resumes in-flight leads once, enrols new ones and parks stranded ones', async () => {
    const { poll, engine, prisma } = setup();
    await poll();
    expect(engine.resume).toHaveBeenCalledWith('org-1', 'in-flight');
    expect(engine.enroll).toHaveBeenCalledWith('org-1', 'fresh');
    expect(engine.finalizeAbandoned).toHaveBeenCalledWith('org-1', 'stranded');
    expect(prisma.lead.findMany.mock.calls[1][0]).toEqual({
      where: { orgId: 'org-1', automationPaused: false, dncStatus: false, status: 'new', firstContactAt: null },
      select: { id: true },
      take: 10,
    });
  });
});

describe('labelSpeakers', () => {
  it('names Telnyx channel 1 as the lead and channel 2 as the assistant', () => {
    expect(labelSpeakers('Channel 1: hi\nchannel 2 : hello there', 'Asha')).toBe('Asha: hi\nAssistant: hello there');
    expect(labelSpeakers('Channel 1: hi', null)).toBe('User: hi');
    expect(labelSpeakers(null, 'Asha')).toBeNull();
  });

  it('names Retell’s User as the lead and Agent as the assistant, and leaves Telnyx text alone', () => {
    expect(labelSpeakers('Agent: hi\nUser: hello', 'Asha', 'retell')).toBe('Assistant: hi\nAsha: hello');
    expect(labelSpeakers('User: hello', 'Asha', 'telnyx')).toBe('User: hello');
  });
});
