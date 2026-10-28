import { describe, expect, it, vi } from 'vitest';
import { LeadWatcherService } from './lead-watcher.service';

/** In-flight leads this instance is not running are picked up on every poll, not only after a restart. */
describe('LeadWatcherService', () => {
  const make = () => {
    const prisma = {
      integration: { findMany: vi.fn(async () => [{ orgId: 'org-1' }]) },
      lead: {
        findMany: vi.fn(async (args: any) => (args.where.firstContactAt?.gte ? [{ id: 'running' }, { id: 'dropped' }] : [])),
      },
    };
    const engine = {
      isRunning: vi.fn((id: string) => id === 'running'),
      resume: vi.fn(async () => true),
      enroll: vi.fn(),
      finalizeAbandoned: vi.fn(),
    };
    const config = { get: vi.fn(() => 86_400_000) };
    return { watcher: new LeadWatcherService(prisma as any, engine as any, config as any), engine };
  };

  it('resumes, on each poll, an in-flight lead that is not running here, and leaves a running one alone', async () => {
    const { watcher, engine } = make();
    await (watcher as any).poll();
    await (watcher as any).poll();
    expect(engine.resume).toHaveBeenCalledTimes(2);
    expect(engine.resume).toHaveBeenCalledWith('org-1', 'dropped');
    expect(engine.resume).not.toHaveBeenCalledWith('org-1', 'running');
  });
});
