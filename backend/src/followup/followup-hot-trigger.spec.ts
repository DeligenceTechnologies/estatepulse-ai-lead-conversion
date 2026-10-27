import { describe, expect, it, vi } from 'vitest';
import { FollowupService, HOT_TRIGGER_NOTE } from './followup.service';

/** Audit D4: "Qualified as hot" can no longer be put on a sequence; one that already carries it says why it never sends. */

const step = { actionType: 'sms' as const, delayMinutes: 60, messageTemplate: 'Hi' };

function setup(current?: { triggers: string[] }) {
  const tx = {
    sequence: {
      // The sequence being saved, then no other sequence holding its conditions.
      findFirst: vi.fn().mockResolvedValueOnce(current ? { id: 'seq-1', orgId: 'org-1', status: 'active', ...current } : null).mockResolvedValue(null),
      create: vi.fn().mockResolvedValue({ id: 'seq-1' }),
      update: vi.fn(),
    },
    $executeRaw: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([]),
  };
  const prisma = {
    $transaction: vi.fn(async (run: (t: typeof tx) => unknown) => run(tx)),
    sequence: { findMany: vi.fn().mockResolvedValue([{ id: 'seq-1', code: 'HOT', name: 'Hot', description: null, status: 'active', triggers: ['qualified_hot'], steps: [], createdAt: new Date() }]) },
    sequenceEnrollment: { groupBy: vi.fn().mockResolvedValue([]) },
  };
  return { svc: new FollowupService(prisma as any, {} as any), tx };
}

describe('FollowupService and the hot condition', () => {
  it('a new sequence cannot take "Qualified as hot"', async () => {
    const { svc, tx } = setup();
    await expect(svc.createSequence('org-1', { name: 'Hot', code: 'HOT', enrollTriggers: ['qualified_hot'], steps: [step] } as any)).rejects.toThrow(HOT_TRIGGER_NOTE);
    expect(tx.sequence.create).not.toHaveBeenCalled();
  });

  it('a sequence that already has it may still be saved, and lists the warning', async () => {
    const { svc } = setup({ triggers: ['qualified_hot'] });
    await expect(svc.updateSequence('org-1', 'seq-1', { name: 'Hot leads' } as any)).resolves.toBeDefined();
    const [listed] = await svc.listSequences('org-1');
    expect(listed.warnings).toEqual([HOT_TRIGGER_NOTE]);
  });

  it('adding it to an existing sequence is refused', async () => {
    const { svc } = setup({ triggers: ['qualified_warm'] });
    await expect(svc.updateSequence('org-1', 'seq-1', { enrollTriggers: ['qualified_warm', 'qualified_hot'] } as any)).rejects.toThrow(HOT_TRIGGER_NOTE);
  });
});
