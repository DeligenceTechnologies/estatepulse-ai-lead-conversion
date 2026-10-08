import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { ApiError, type LeadSourceConfig, type ProviderConnection } from '../../api/client';
import { ConnectionCards } from './ConnectionCards';

/**
 * How Integrations & Webhooks asks for its lead sources (GET /api/v1/lead-sources)
 * and form-provider accounts (GET /api/v1/integrations): together, with each
 * answer landing in the cards as it did when they were asked for one after the
 * other.
 *
 * The cards are stand-ins that record their props; Telnyx and Scheduling load
 * themselves and are not under test. There is no DOM library in this project,
 * so a minimal document below gives React DOM the node operations it uses, as
 * in LeadDetailModal.spec.
 */

const api = vi.hoisted(() => ({ sources: null as unknown as Mock, connections: null as unknown as Mock }));
vi.mock('../../api/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../api/client')>();
  return {
    ...actual,
    api: { ...actual.api, listLeadSources: () => api.sources() },
    providersApi: { ...actual.providersApi, connections: () => api.connections() },
  };
});
vi.mock('../../context/AppContext', () => ({
  useApp: () => ({ setActiveView: () => {}, setFocusLeadSourceId: () => {} }),
}));
vi.mock('./TelnyxCard', () => ({ TelnyxCard: () => null }));
vi.mock('./SchedulingCards', () => ({ SchedulingCards: () => null }));

type CardProps = { title: string; connected: boolean; loading?: boolean; action: { label: string } };
const cards = vi.hoisted(() => ({}) as Record<string, CardProps>);
vi.mock('./IntegrationCard', () => ({
  IntegrationCard: (props: CardProps) => {
    cards[props.title] = props;
    return null;
  },
}));

const source = (over: Partial<LeadSourceConfig>): LeadSourceConfig => ({
  id: 'src', name: 'Website', code: 'web', isActive: true, requireSignature: true, ingestStatus: 'ACTIVE',
  mappingStatus: 'MAPPED', signingSecretPreview: null, signingSecretSetAt: null, externalFormName: null,
  lastEventAt: null, createdAt: '2026-10-01T00:00:00.000Z', webhookUrl: 'https://hooks.example.test/w', ...over,
});
const API_SOURCE = source({ id: 'api', connectionMethod: 'API', provider: 'TALLY', remoteState: 'INSTALLED' });
const MANUAL_SOURCE = source({ id: 'manual', connectionMethod: 'MANUAL' });
const ACCOUNT: ProviderConnection = {
  id: 'cred', provider: 'TALLY', label: 'Olive', credentialPreview: 'tly-abcd…wxyz', accountEmail: 'olive@example.test',
  accountName: null, status: 'ACTIVE', lastVerifiedAt: null, lastErrorCode: null, createdAt: '2026-10-01T00:00:00.000Z',
  leadSourceCount: 0,
};

const deferred = <T,>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};

// --- a minimal document -------------------------------------------------------

const HTML = 'http://www.w3.org/1999/xhtml';
class FakeNode extends EventTarget {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  nodeValue: string | null = null;
  style: Record<string, unknown> = {};
  constructor(public nodeType: number, public nodeName: string, public namespaceURI: string | null = HTML) {
    super();
  }
  get ownerDocument() { return doc; }
  get tagName() { return this.nodeName; }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? '') : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.childNodes = text ? [Object.assign(new FakeNode(3, '#text'), { nodeValue: text, parentNode: this })] : [];
  }
  appendChild(child: FakeNode) { return this.insertBefore(child, null); }
  insertBefore(child: FakeNode, before: FakeNode | null) {
    child.parentNode?.removeChild(child);
    const at = before ? this.childNodes.indexOf(before) : -1;
    this.childNodes.splice(at < 0 ? this.childNodes.length : at, 0, child);
    child.parentNode = this;
    return child;
  }
  removeChild(child: FakeNode) {
    this.childNodes = this.childNodes.filter((c) => c !== child);
    child.parentNode = null;
    return child;
  }
  setAttribute() {}
  removeAttribute() {}
}

const g = globalThis as Record<string, unknown>;
g['IS_REACT_ACT_ENVIRONMENT'] = true;
g['window'] ??= globalThis;
g['HTMLIFrameElement'] ??= class {}; // read by React's commit phase

const doc = Object.assign(new FakeNode(9, '#document', null), {
  createElement: (tag: string) => new FakeNode(1, tag.toUpperCase()),
  createElementNS: (ns: string, tag: string) => new FakeNode(1, tag, ns),
  createTextNode: (text: string) => Object.assign(new FakeNode(3, '#text'), { nodeValue: text }),
  activeElement: null,
});

// --- rendering ----------------------------------------------------------------

let root: Root | null = null;
let container: FakeNode;

const mount = async () => {
  container = new FakeNode(1, 'DIV');
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root!.render(<ConnectionCards />));
};
const settle = (fn: () => void = () => {}) =>
  act(async () => {
    fn();
    await new Promise((r) => setTimeout(r, 0));
  });

beforeEach(() => {
  for (const title of Object.keys(cards)) delete cards[title];
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('ConnectionCards loading', () => {
  it('asks for the lead sources and the accounts together, once each', async () => {
    const sources = deferred<LeadSourceConfig[]>();
    const accounts = deferred<ProviderConnection[]>();
    api.sources = vi.fn(() => sources.promise);
    api.connections = vi.fn(() => accounts.promise);

    await mount();
    // Neither has answered, and both are already in flight.
    expect(api.sources).toHaveBeenCalledTimes(1);
    expect(api.connections).toHaveBeenCalledTimes(1);
    expect(cards.Tally).toMatchObject({ loading: true });
    expect(cards.Webhook).toMatchObject({ loading: true });

    await settle(() => sources.resolve([API_SOURCE, MANUAL_SOURCE]));
    await settle(() => accounts.resolve([ACCOUNT]));
    expect(api.sources).toHaveBeenCalledTimes(1);
    expect(api.connections).toHaveBeenCalledTimes(1);
    expect(cards.Tally).toMatchObject({ loading: false, connected: true, action: { label: 'Manage / add form' } });
    expect(cards.Webhook).toMatchObject({ loading: false, connected: true, action: { label: 'Add webhook' } });
  });

  it.each([
    ['the accounts', true],
    ['the sources', false],
  ])('an account with no form yet reads "Add a form" when %s answer first', async (_, accountsFirst) => {
    const sources = deferred<LeadSourceConfig[]>();
    const accounts = deferred<ProviderConnection[]>();
    api.sources = vi.fn(() => sources.promise);
    api.connections = vi.fn(() => accounts.promise);

    await mount();
    if (accountsFirst) await settle(() => accounts.resolve([ACCOUNT]));
    await settle(() => sources.resolve([MANUAL_SOURCE]));
    // The sources are in, so the cards have stopped loading.
    expect(cards.Tally).toMatchObject({ loading: false });
    if (!accountsFirst) await settle(() => accounts.resolve([ACCOUNT]));

    expect(cards.Tally).toMatchObject({ loading: false, connected: true, action: { label: 'Add a form' } });
    expect(cards.Webhook).toMatchObject({ loading: false, connected: true, action: { label: 'Add webhook' } });
  });

  it('a failed accounts read is "no account", even while the sources are still loading', async () => {
    const sources = deferred<LeadSourceConfig[]>();
    api.sources = vi.fn(() => sources.promise);
    // Not a vi.fn, which attaches a handler of its own to what it returns.
    api.connections = (() => Promise.reject(new ApiError(500, 'INTERNAL', 'Something went wrong'))) as Mock;
    // A browser logs "Uncaught (in promise)" for a rejection nobody is
    // listening to yet, which this one is until the sources answer.
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    await mount();
    await settle(); // the accounts have failed; the sources have not answered
    process.off('unhandledRejection', unhandled);
    expect(unhandled).not.toHaveBeenCalled();
    expect(cards.Tally).toMatchObject({ loading: true });

    await settle(() => sources.resolve([]));
    expect(cards.Tally).toMatchObject({ loading: false, connected: false, action: { label: 'Connect Tally' } });
    expect(cards.Webhook).toMatchObject({ loading: false, connected: false, action: { label: 'Create a webhook' } });
    expect(container.textContent).not.toContain("Can't reach the backend");
  });

  it('a failed sources read shows the error, ends loading, and still applies the accounts', async () => {
    api.sources = vi.fn(() => Promise.reject(new ApiError(0, 'NETWORK', 'Cannot reach the API.')));
    api.connections = vi.fn(() => Promise.resolve([ACCOUNT]));

    await mount();
    await settle();
    expect(container.textContent).toContain("Can't reach the backend");
    expect(container.textContent).toContain('Cannot reach the API.');
    expect(cards.Tally).toMatchObject({ loading: false, connected: true, action: { label: 'Add a form' } });
    expect(cards.Webhook).toMatchObject({ loading: false, connected: false });
  });
});
