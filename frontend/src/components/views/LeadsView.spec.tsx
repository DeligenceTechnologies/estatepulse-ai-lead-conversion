import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import type { LiveEvent } from '../../lib/liveEvents';
import type { LiveQueryOptions } from '../../lib/useLiveQuery';
import { LeadsView } from './LeadsView';

/**
 * How LeadsView wires its poll to the live stream. The hooks are stand-ins that
 * record what LeadsView hands them; their own timing is covered in
 * useLiveQuery.spec.tsx.
 */

const s = vi.hoisted(() => ({
  connected: false,
  fetcher: null as null | (() => Promise<unknown>),
  options: undefined as LiveQueryOptions | undefined,
  onEvent: null as null | ((e: LiveEvent) => void),
  invalidate: null as unknown as Mock,
  list: null as unknown as Mock,
  stats: null as unknown as Mock,
}));

vi.mock('../../lib/useLiveQuery', () => ({
  useLiveQuery: (fetcher: () => Promise<unknown>, options?: LiveQueryOptions) => {
    s.fetcher = fetcher;
    s.options = options;
    return { data: null, error: null, refreshing: false, stale: false, refresh: () => {}, invalidate: s.invalidate };
  },
}));
vi.mock('../../lib/liveEvents', () => ({
  useLiveEvents: (onEvent: (e: LiveEvent) => void) => {
    s.onEvent = onEvent;
    return { connected: s.connected };
  },
}));
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return { ...actual, leadsApi: { ...actual.leadsApi, list: (...a: unknown[]) => s.list(...a), stats: () => s.stats() } };
});
vi.mock('../../context/AuthContext', () => ({ useAuth: () => ({ agentProfileId: null, role: 'owner' }) }));
vi.mock('../../context/AppContext', () => ({
  useApp: () => ({ setSelectedLeadId: () => {}, setPreCallLeadId: () => {}, registerExternalLeads: () => {} }),
}));

const render = () =>
  renderToString(
    <MemoryRouter initialEntries={['/leads']}>
      <LeadsView onOpenNewLead={() => {}} />
    </MemoryRouter>,
  );

const event = (type: LiveEvent['type']): LiveEvent => ({ type, leadSourceId: null, at: new Date().toISOString() });

beforeEach(() => {
  s.connected = false;
  s.invalidate = vi.fn();
  s.list = vi.fn(async () => []);
  s.stats = vi.fn(async () => ({ byStatus: {}, total: 0 }));
});

describe('LeadsView live wiring', () => {
  it('stream down: the default fast poll (no cadence override)', () => {
    render();
    expect(s.options).toBeUndefined();
  });

  it('stream up: polls once a minute, never faster', () => {
    s.connected = true;
    render();
    expect(s.options).toEqual({ baseIntervalMs: 60_000, maxIntervalMs: 60_000 });
  });

  it('one load fetches /v1/leads (unfiltered) and /v1/leads/stats together', async () => {
    render();
    const result = await s.fetcher!();
    expect(s.list).toHaveBeenCalledTimes(1);
    expect(s.list).toHaveBeenCalledWith();
    expect(s.stats).toHaveBeenCalledTimes(1);
    expect(result).toEqual({ leads: [], stats: { byStatus: {}, total: 0 } });
  });

  it('lead.created and lead.assigned refetch at once; other events do not', () => {
    for (const connected of [false, true]) {
      s.connected = connected;
      s.invalidate = vi.fn();
      render();
      s.onEvent!(event('lead.created'));
      s.onEvent!(event('lead.assigned'));
      s.onEvent!(event('delivery.received'));
      expect(s.invalidate).toHaveBeenCalledTimes(2);
    }
  });
});
