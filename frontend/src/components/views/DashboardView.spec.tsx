import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { messageFor } from '../../lib/api';
import type { OrganizationMember } from '../../utils/agentsApi';
import type { OwnerDashboard } from '../../utils/dashboardApi';
import { DashboardContent, useDashboardData } from './DashboardView';

/**
 * The dashboard's two reads are independent: the main dashboard renders as soon
 * as GET /api/dashboard answers, and Agent Load has its own loading and error
 * states for GET /api/agents.
 *
 * Timing is tested on the hook (a probe that renders nothing, so no DOM is
 * needed, as in useLiveQuery.spec); what each state renders is tested on
 * DashboardContent with renderToString.
 */

const api = vi.hoisted(() => ({ dashboard: null as unknown as Mock, members: null as unknown as Mock }));
vi.mock('../../utils/dashboardApi', () => ({ getOwnerDashboard: () => api.dashboard() }));
vi.mock('../../utils/agentsApi', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../utils/agentsApi')>()),
  listMembers: () => api.members(),
}));
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { firstName: 'Ada' }, organization: { name: 'Org A Realty' } }),
}));

const DASHBOARD: OwnerDashboard = {
  leads: { total: 12, last7Days: 4, byStatus: { new: 5, qualified: 7 }, byTemperature: { hot: 3, warm: 2, cold: 1, unrated: 6 } },
  speedToLead: { sample: 0, medianSeconds: null, within60sPct: null },
  attention: { hotUnassigned: 2, neverContacted: 1, needsReview: 0 },
  calls7Days: { total: 0, byStatus: {} },
  upcomingAppointments: 9,
  sources30Days: [],
};

const member = (over: Partial<OrganizationMember>): OrganizationMember => ({
  id: 'u', firstName: 'Ann', lastName: 'Agent', email: 'ann@example.test', phone: null, role: 'agent',
  status: 'active', memberSince: null, timezone: 'America/Chicago', title: null, maxActiveLeads: 10,
  hasProfile: true, profileId: 'p', takingLeads: true, activeLeads: 3, calendarLinked: false, ...over,
});

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
};

// --- the hook ------------------------------------------------------------------

const g = globalThis as Record<string, unknown>;
g['IS_REACT_ACT_ENVIRONMENT'] = true;
g['window'] ??= globalThis;
g['HTMLIFrameElement'] ??= class {}; // read by React's commit phase
const doc = Object.assign(new EventTarget(), { nodeType: 9 });

let root: Root | null = null;
let state: ReturnType<typeof useDashboardData>;
const Probe = () => {
  state = useDashboardData();
  return null;
};
const mountHook = async () => {
  const container = Object.assign(new EventTarget(), {
    nodeType: 1, nodeName: 'DIV', tagName: 'DIV', namespaceURI: 'http://www.w3.org/1999/xhtml', ownerDocument: doc,
  });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<Probe />));
};
const settle = (fn: () => void) => act(async () => fn());

const FAILED = messageFor(new Error('boom'));

beforeEach(() => {
  api.dashboard = vi.fn();
  api.members = vi.fn();
});
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
});

describe('useDashboardData', () => {
  it('dashboard first: data is ready while the roster is still loading, and loading holds until both settle', async () => {
    const d = deferred<OwnerDashboard>();
    const m = deferred<OrganizationMember[]>();
    api.dashboard.mockReturnValue(d.promise);
    api.members.mockReturnValue(m.promise);
    await mountHook();
    expect(api.dashboard).toHaveBeenCalledTimes(1);
    expect(api.members).toHaveBeenCalledTimes(1);

    await settle(() => d.resolve(DASHBOARD));
    expect(state.data).toBe(DASHBOARD);
    expect(state.members).toBeNull();
    expect(state.loading).toBe(true);

    await settle(() => m.resolve([member({})]));
    expect(state.members).toHaveLength(1);
    expect(state.loading).toBe(false);
  });

  it('roster first: loading still holds until the dashboard settles too', async () => {
    const d = deferred<OwnerDashboard>();
    api.dashboard.mockReturnValue(d.promise);
    api.members.mockResolvedValue([]);
    await mountHook();
    await settle(() => {});
    expect(state.members).toEqual([]);
    expect(state.loading).toBe(true);
    await settle(() => d.resolve(DASHBOARD));
    expect(state.loading).toBe(false);
  });

  it('a roster that never answers does not hold the dashboard back', async () => {
    api.dashboard.mockResolvedValue(DASHBOARD);
    api.members.mockReturnValue(new Promise(() => {}));
    await mountHook();
    await settle(() => {});
    expect(state.data).toBe(DASHBOARD);
    expect(state.error).toBeNull();
    expect(state.members).toBeNull();
    expect(state.loading).toBe(true);
  });

  it('a failed roster sets membersError only; the dashboard is unaffected', async () => {
    api.dashboard.mockResolvedValue(DASHBOARD);
    api.members.mockRejectedValue(new Error('boom'));
    await mountHook();
    await settle(() => {});
    expect(state.data).toBe(DASHBOARD);
    expect(state.error).toBeNull();
    expect(state.membersError).toBe(FAILED);
    expect(state.loading).toBe(false);
  });

  it('a failed dashboard sets error; the roster still loads', async () => {
    api.dashboard.mockRejectedValue(new Error('boom'));
    api.members.mockResolvedValue([member({})]);
    await mountHook();
    await settle(() => {});
    expect(state.error).toBe(FAILED);
    expect(state.data).toBeNull();
    expect(state.members).toHaveLength(1);
    expect(state.loading).toBe(false);
  });

  it('Refresh requests both again, and a recovered roster clears its error', async () => {
    api.dashboard.mockResolvedValue(DASHBOARD);
    api.members.mockRejectedValueOnce(new Error('boom')).mockResolvedValue([member({})]);
    await mountHook();
    await settle(() => {});
    expect(state.membersError).toBe(FAILED);

    await settle(() => void state.load());
    expect(api.dashboard).toHaveBeenCalledTimes(2);
    expect(api.members).toHaveBeenCalledTimes(2);
    expect(state.membersError).toBeNull();
    expect(state.members).toHaveLength(1);
  });
});

// --- what each state renders ----------------------------------------------------

type ContentProps = Parameters<typeof DashboardContent>[0];
const render = (over: Partial<ContentProps>) =>
  renderToString(
    <MemoryRouter>
      <DashboardContent
        data={null}
        members={null}
        error={null}
        membersError={null}
        loading={false}
        load={async () => {}}
        {...over}
      />
    </MemoryRouter>,
  );

describe('DashboardContent', () => {
  it('dashboard loaded, roster pending: the dashboard renders and Agent Load shows placeholders', () => {
    const html = render({ data: DASHBOARD, loading: true });
    expect(html).toContain('Needs Attention');
    expect(html).toContain('Pipeline by Status');
    expect(html).toContain('Agent Load');
    expect(html).toContain('Loading agents');
    expect(html).not.toContain('No active agents yet');
  });

  it('roster loaded and empty: "No active agents yet", no placeholders', () => {
    const html = render({ data: DASHBOARD, members: [] });
    expect(html).toContain('No active agents yet');
    expect(html).not.toContain('Loading agents');
  });

  it('roster failed: the dashboard renders, the error is inside Agent Load, and there is no dashboard banner', () => {
    const html = render({ data: DASHBOARD, membersError: 'Agents are unavailable' });
    expect(html).toContain('Needs Attention');
    // renderToString separates the text and the message with a <!-- --> marker.
    expect(html).toMatch(/Could not load agents: (<!-- -->)?Agents are unavailable/);
    expect(html).not.toContain('Loading agents');
    expect(html).not.toContain('No active agents yet');
    expect(html).not.toContain('Could not load the dashboard');
  });

  it('dashboard failed: the existing banner, and no panels', () => {
    const html = render({ error: 'Server unavailable', members: [member({})] });
    expect(html).toContain('Could not load the dashboard');
    expect(html).toContain('Server unavailable');
    expect(html).not.toContain('Agent Load');
  });

  it('populated roster: the same bars as before — active profiles only, current / cap', () => {
    const html = render({
      data: DASHBOARD,
      members: [
        member({ id: 'a', firstName: 'Ann', lastName: 'Agent', activeLeads: 3, maxActiveLeads: 10 }),
        member({ id: 'b', firstName: 'Ben', lastName: 'Busy', activeLeads: 7, maxActiveLeads: 7 }),
        member({ id: 'c', firstName: 'Sue', lastName: 'Spended', status: 'suspended' }),
        member({ id: 'o', firstName: 'Owen', lastName: 'Owner', role: 'owner', hasProfile: false, profileId: null, maxActiveLeads: null }),
      ],
    });
    expect(html).toContain('title="Ann Agent: 3 / 10"');
    expect(html).toContain('title="Ben Busy: 7 / 7"');
    expect(html).toContain('width:30%');
    expect(html).toContain('width:100%');
    expect(html).not.toContain('Sue Spended');
    expect(html).not.toContain('Owen Owner');
    expect(html).not.toContain('Loading agents');
  });
});
