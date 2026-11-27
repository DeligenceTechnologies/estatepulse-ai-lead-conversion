import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { ActivityFeed } from '../../utils/activityApi';
import { ActivityView } from './ActivityPanel';

vi.mock('../../context/AppContext', () => ({ useApp: () => ({ setSelectedLeadId: () => undefined }) }));

const feed = (over: Partial<ActivityFeed> = {}): ActivityFeed => ({ needsYou: [], alerts: [], canReconnect: false, items: [], nextCursor: null, ...over });
const render = (f: ActivityFeed) =>
  renderToString(
    <MemoryRouter>
      <ActivityView feed={f} onOpenChat={() => undefined} />
    </MemoryRouter>,
  );

describe('Activity panel', () => {
  it('puts cards waiting on the user first', () => {
    const html = render(
      feed({ needsYou: [{ actionId: 'a1', threadId: 't1', title: 'Text Maria Lopez', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 5 * 60_000).toISOString() }] }),
    );
    expect(html).toContain('Needs you');
    expect(html).toContain('Text Maria Lopez');
    expect(html.indexOf('Needs you')).toBeLessThan(html.indexOf('Last 24 hours'));
  });

  it('shows a broken app to everyone, with Reconnect only for people who may fix it', () => {
    const alerts = [{ app: 'Calendly', state: 'needs_reconnect' as const, message: 'Leads cannot book meetings.', reconnectPath: '/settings?tab=calendar' }];
    expect(render(feed({ alerts, canReconnect: true }))).toContain('Reconnect</button>');
    const forAgent = render(feed({ alerts }));
    expect(forAgent).toContain('Calendly is disconnected');
    expect(forAgent).not.toContain('Reconnect</button>');
  });

  it("lists the last day's events with the lead's name, and says when there are none", () => {
    const html = render(feed({ items: [{ id: 'e1', kind: 'interested', at: new Date().toISOString(), text: 'is interested', lead: { id: 'l1', name: 'Maria Lopez' }, tone: 'good' }] }));
    expect(html).toContain('Maria Lopez');
    expect(html).toContain('is interested');
    expect(render(feed())).toContain('Nothing new in the last 24 hours.');
  });
});
