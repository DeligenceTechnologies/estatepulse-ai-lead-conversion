import { describe, expect, it, vi } from 'vitest';
import { LeadWatcherService } from './lead-watcher.service';

/** The watcher resumes any in-flight lead the engine is not running — on every poll, not only after boot. */

const ORG = 'org-1';

function setup(opts: { inFlight: string[]; running: string[] }) {
  const prisma = {
    integration: { findMany: vi.fn().mockResolvedValue([{ orgId: ORG }]) },
    lead: {
      findMany: vi.fn(async ({ where }: any) => {
        if (where.firstContactAt?.gte) return opts.inFlight.map((id) => ({ id }));
        return [];
      }),
    },
  };
  const engine = {
    isRunning: vi.fn((id: string) => opts.running.includes(id)),
    resume: vi.fn().mockResolvedValue(true),
    enroll: vi.fn(),
    finalizeAbandoned: vi.fn(),
  };
  const config = { get: vi.fn((key: string) => ({ STRATEGY_ENGINE: true, ENGINE_POLL_MS: 15_000, STRATEGY_STALE_MS: 86_400_000 })[key]) };
  const watcher = new LeadWatcherService(prisma as any, engine as any, config as any);
  return { watcher, engine };
}

describe('LeadWatcherService', () => {
  it('resumes the in-flight leads it is not running, and leaves the running ones alone', async () => {
    const { watcher, engine } = setup({ inFlight: ['lead-a', 'lead-b', 'lead-c'], running: ['lead-b'] });
    await watcher.poll();
    expect(engine.resume.mock.calls.map(([, id]) => id)).toEqual(['lead-a', 'lead-c']);
  });

  it('looks again on every poll: a lead dropped between two polls is picked up by the second', async () => {
    const running = ['lead-a'];
    const { watcher, engine } = setup({ inFlight: ['lead-a'], running });
    await watcher.poll();
    expect(engine.resume).not.toHaveBeenCalled();
    running.length = 0;
    await watcher.poll();
    expect(engine.resume).toHaveBeenCalledWith(ORG, 'lead-a');
  });
});
