import { describe, expect, it, vi } from 'vitest';
import { FollowupService, HOT_TRIGGER_NOTE } from './followup.service';

/** A hot lead goes straight to an agent, so a sequence on "Qualified as hot" would never send anything. */
describe('the hot trigger', () => {
  const service = (current: string[] = []) => {
    const tx = {
      $executeRaw: vi.fn(),
      $queryRaw: vi.fn(async () => []),
      sequence: {
        findFirst: vi.fn(async () => ({ id: 'seq-1', orgId: 'org-1', triggers: current, status: 'inactive', steps: [] })),
        update: vi.fn(async () => ({})),
      },
    };
    const prisma = { $transaction: vi.fn(async (fn: (t: typeof tx) => unknown) => fn(tx)) };
    return { svc: new FollowupService(prisma as any, {} as any, {} as any), tx };
  };

  it('cannot be put on a new sequence', async () => {
    const { svc } = service();
    await expect(svc.createSequence('org-1', { name: 'Hot', code: 'hot', enrollTriggers: ['qualified_hot'], steps: [] } as any)).rejects.toThrow(HOT_TRIGGER_NOTE);
  });

  it('cannot be added to an existing one, which may keep it if it already had it', async () => {
    await expect(service().svc.updateSequence('org-1', 'seq-1', { enrollTriggers: ['qualified_hot'] } as any)).rejects.toThrow(HOT_TRIGGER_NOTE);
    const kept = service(['qualified_hot']);
    await kept.svc.updateSequence('org-1', 'seq-1', { enrollTriggers: ['qualified_hot'] } as any).catch(() => undefined);
    expect(kept.tx.sequence.update).toHaveBeenCalled();
  });
});
