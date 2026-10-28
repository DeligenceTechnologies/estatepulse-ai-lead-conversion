import { describe, expect, it, vi } from 'vitest';
import { labelSpeakers } from '@/history/history.service';
import { LeadWatcherService } from './lead-watcher.service';

/** With RETELL_ENABLED the strategy engine also works organizations whose active calling account is Retell. */
function orgsQuery(retell: boolean) {
  const prisma = { integration: { findMany: vi.fn(async () => []) }, lead: { findMany: vi.fn(async () => []) } };
  const config = { get: vi.fn((key: string) => ({ STRATEGY_STALE_MS: 86_400_000, RETELL_ENABLED: retell })[key]) };
  const watcher = new LeadWatcherService(prisma as any, {} as any, config as any);
  return (watcher as any).poll().then(() => (prisma.integration.findMany.mock.calls as any[])[0][0].where);
}

describe('LeadWatcherService and the calling provider', () => {
  it('works only organizations with an active Telnyx account while Retell is off', async () => {
    await expect(orgsQuery(false)).resolves.toEqual({ provider: 'telnyx', status: 'active' });
  });

  it('with RETELL_ENABLED, also works organizations whose active calling account is Retell', async () => {
    await expect(orgsQuery(true)).resolves.toEqual({ provider: { in: ['telnyx', 'retell'] }, status: 'active' });
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
