import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ConnectedApp, ConnectedAppsDTO } from '../../utils/connectedAppsApi';
import { ConnectedAppsView } from './ConnectedApps';

const app = (over: Partial<ConnectedApp>): ConnectedApp => ({
  id: 'a1',
  provider: 'telnyx',
  label: 'Telnyx',
  account: '+1 512 555 0100',
  state: 'connected',
  lastSyncAt: null,
  message: null,
  impact: null,
  reconnectPath: '/settings?tab=telnyx',
  ...over,
});

const render = (data: ConnectedAppsDTO) => renderToString(<ConnectedAppsView data={data} collapsed={false} onOpen={() => undefined} />);

describe('Connected apps in the sidebar', () => {
  it('lists each app with its account while it works', () => {
    const html = render({ canReconnect: true, apps: [app({})] });
    expect(html).toContain('Connected apps');
    expect(html).toContain('Telnyx');
    expect(html).toContain('+1 512 555 0100');
    expect(html).not.toContain('Reconnect</button>');
  });

  it('offers Reconnect on a broken app only to people who may manage apps', () => {
    const broken = app({ id: 'c1', provider: 'calendly', label: 'Calendly', state: 'needs_reconnect', message: 'Calendly stopped accepting the connection.' });
    expect(render({ canReconnect: true, apps: [broken] })).toContain('Reconnect</button>');
    const forAgent = render({ canReconnect: false, apps: [broken] });
    expect(forAgent).toContain('Disconnected');
    expect(forAgent).not.toContain('Reconnect</button>');
  });

  it('shows nothing when no app is connected', () => {
    expect(render({ canReconnect: true, apps: [] })).toBe('');
  });
});
