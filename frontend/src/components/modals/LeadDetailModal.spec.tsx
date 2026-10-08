import React, { StrictMode, act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { messageFor } from '../../lib/api';
import type { Lead } from '../../types';
import type { LeadBookingOptions } from '../../utils/calendarApi';
import type { MessageRow } from '../../utils/historyApi';
import { LeadAppointments } from '../leads/LeadBooking';
import { LeadDetailModal } from './LeadDetailModal';

/**
 * How often the lead dossier asks for GET /api/leads/:id/booking-options.
 *
 * The real modal is rendered, with its API modules and the app context
 * replaced. There is no DOM library in this project, so a minimal document
 * below gives React DOM the few node operations it uses; tabs are switched by
 * calling the buttons' own React click handlers.
 */

const api = vi.hoisted(() => ({ bookingOptions: null as unknown as Mock }));
vi.mock('../../utils/calendarApi', () => ({
  getLeadBookingOptions: (id: string) => api.bookingOptions(id),
  getLeadAppointments: () => Promise.resolve([]),
}));
vi.mock('../../utils/assistantApi', () => ({
  getLeadFlow: () => Promise.reject(new Error('not under test')),
  enrollLead: () => Promise.resolve(),
}));
const history = vi.hoisted(() => ({
  calls: null as unknown as Mock,
  leadMessages: null as unknown as Mock,
  conversations: null as unknown as Mock,
  threadMessages: null as unknown as Mock,
}));
vi.mock('../../utils/historyApi', () => ({
  listCalls: (filters: unknown) => history.calls(filters),
  listLeadMessages: (leadId: string) => history.leadMessages(leadId),
  listConversations: (...args: unknown[]) => history.conversations(...args),
  listMessages: (id: string) => history.threadMessages(id),
  getCall: () => Promise.resolve(null),
}));
vi.mock('../views/CallsView', () => ({ OUTCOME_STYLES: {}, duration: () => '' }));

// The assign control is a stand-in that lets a test assign another agent the
// way the real one reports it.
const assignControl = vi.hoisted(() => ({ onAssigned: null as null | ((a: { id: string; name: string }) => void) }));
vi.mock('../leads/AssignAgentControl', () => ({
  AssignAgentControl: (props: { onAssigned: (a: { id: string; name: string }) => void }) => {
    assignControl.onAssigned = props.onAssigned;
    return null;
  },
}));

const LEAD_ID = '01a10d51-51a2-7468-8340-60a8b40b2aae';
const app = vi.hoisted(() => ({ selectedLeadId: null as string | null, lead: null as unknown }));
vi.mock('../../context/AppContext', () => ({
  useApp: () => ({
    selectedLeadId: app.selectedLeadId,
    setSelectedLeadId: () => {},
    findLead: (id: string | null) => (id && id === (app.lead as Lead).id ? app.lead : undefined),
    setPreCallLeadId: () => {},
    // The demo roster a demo-store lead is resolved against.
    agents: [{ id: 'agent-1', name: 'Ann Agent' }],
  }),
}));

const lead = (over: Partial<Lead> = {}): Lead => ({
  id: LEAD_ID, organizationId: 'org', assignedAgentId: 'agent-1', assignedAgentName: 'Ann Agent',
  firstName: 'Bea', lastName: 'Buyer', email: 'bea@example.test', phone: '+15125550123', source: 'Website',
  status: 'new', leadType: 'buyer', preferredLocation: 'Austin', budgetMin: 300000, budgetMax: 450000,
  propertyType: 'House', bedrooms: 3, timeline: '1-3 months', financingStatus: 'Pre-approved',
  preapprovalStatus: true, score: 80, temperature: 'hot', consentStatus: 'granted', dncStatus: false,
  createdAt: '2026-10-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...over,
}) as Lead;

const OPTIONS: LeadBookingOptions = {
  agent: { id: 'agent-1', name: 'Ann Agent' },
  provider: 'calendly',
  eventTypes: [{ id: 'et', name: 'Buyer consult', durationMinutes: 30, bookingUrl: 'https://calendly.com/ann/consult' }],
  blocker: null,
};

// --- a minimal document -------------------------------------------------------

const HTML = 'http://www.w3.org/1999/xhtml';
class FakeNode extends EventTarget {
  childNodes: FakeNode[] = [];
  parentNode: FakeNode | null = null;
  attributes = new Map<string, string>();
  style: Record<string, unknown> = { setProperty() {}, removeProperty() {} };
  nodeValue: string | null = null;
  constructor(
    public nodeType: number,
    public nodeName: string,
    public ownerDocument: unknown,
    public namespaceURI: string | null = HTML,
  ) {
    super();
  }
  get tagName() { return this.nodeName; }
  get firstChild() { return this.childNodes[0] ?? null; }
  get lastChild() { return this.childNodes[this.childNodes.length - 1] ?? null; }
  get nextSibling() {
    const siblings = this.parentNode?.childNodes ?? [];
    return siblings[siblings.indexOf(this) + 1] ?? null;
  }
  get textContent(): string {
    return this.nodeType === 3 ? (this.nodeValue ?? '') : this.childNodes.map((c) => c.textContent).join('');
  }
  set textContent(text: string) {
    this.childNodes.forEach((c) => (c.parentNode = null));
    this.childNodes = text ? [Object.assign(new FakeNode(3, '#text', this.ownerDocument), { nodeValue: text })] : [];
    this.childNodes.forEach((c) => (c.parentNode = this));
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
  setAttribute(name: string, value: unknown) { this.attributes.set(name, String(value)); }
  removeAttribute(name: string) { this.attributes.delete(name); }
  getAttribute(name: string) { return this.attributes.get(name) ?? null; }
  hasAttribute(name: string) { return this.attributes.has(name); }
}

const g = globalThis as Record<string, unknown>;
g['IS_REACT_ACT_ENVIRONMENT'] = true;
g['window'] ??= globalThis;
g['HTMLIFrameElement'] ??= class {}; // read by React's commit phase
// The modal listens for Escape on window.
const windowEvents = new EventTarget();
g['addEventListener'] ??= windowEvents.addEventListener.bind(windowEvents);
g['removeEventListener'] ??= windowEvents.removeEventListener.bind(windowEvents);

const doc = new FakeNode(9, '#document', null) as FakeNode & Record<string, unknown>;
Object.assign(doc, {
  createElement: (tag: string) => new FakeNode(1, tag.toUpperCase(), doc),
  createElementNS: (ns: string, tag: string) => new FakeNode(1, tag, doc, ns),
  createTextNode: (text: string) => Object.assign(new FakeNode(3, '#text', doc), { nodeValue: text }),
  activeElement: null,
  defaultView: globalThis,
});
doc['body'] = new FakeNode(1, 'BODY', doc);

// --- rendering and interaction ------------------------------------------------

let root: Root | null = null;
let container: FakeNode;
let strict = false;

const render = () => act(async () => root!.render(strict ? <StrictMode><LeadDetailModal /></StrictMode> : <LeadDetailModal />));
const mount = async () => {
  container = new FakeNode(1, 'DIV', doc);
  root = createRoot(container as unknown as HTMLElement);
  await render();
};
const open = async (l: Lead) => {
  app.lead = l;
  app.selectedLeadId = l.id;
  await render();
};
const close = async () => {
  app.selectedLeadId = null;
  await render();
};
const text = () => container.textContent;
const nodes = (n: FakeNode): FakeNode[] => [n, ...n.childNodes.flatMap(nodes)];
const tab = (label: string) =>
  act(async () => {
    const button = nodes(container).find((n) => n.nodeName === 'BUTTON' && n.textContent.startsWith(label));
    if (!button) throw new Error(`no "${label}" tab`);
    const props = Object.entries(button).find(([k]) => k.startsWith('__reactProps$'))![1] as { onClick: () => void };
    props.onClick();
  });
const requests = () => api.bookingOptions.mock.calls.length;

beforeEach(async () => {
  api.bookingOptions = vi.fn(() => Promise.resolve(OPTIONS));
  history.calls = vi.fn(() => Promise.resolve([]));
  history.leadMessages = vi.fn(() => Promise.resolve([]));
  history.conversations = vi.fn(() => Promise.resolve([]));
  history.threadMessages = vi.fn(() => Promise.resolve([]));
  app.selectedLeadId = null;
  strict = false;
  await mount();
});

afterEach(async () => {
  await act(async () => root?.unmount());
  root = null;
});

describe('LeadDetailModal: booking options', () => {
  it('opening a lead asks once, and the Overview shows the agent’s pages', async () => {
    await open(lead());

    expect(api.bookingOptions.mock.calls).toEqual([[LEAD_ID]]);
    expect(text()).toContain('Buyer consult · 30 min');
    expect(text()).toContain('With Ann Agent, the assigned agent.');
  });

  it('switching between Overview and Appointments does not ask again', async () => {
    await open(lead());
    await tab('Appointments');
    expect(text()).toContain('Buyer consult · 30 min');
    await tab('Overview');
    await tab('AI Calls');
    await tab('Appointments');
    await tab('Overview');

    expect(requests()).toBe(1);
    expect(text()).toContain('Buyer consult · 30 min');
  });

  it('assigning another agent asks again, once, for that agent', async () => {
    await open(lead());
    api.bookingOptions.mockResolvedValueOnce({ ...OPTIONS, agent: { id: 'agent-2', name: 'Bo Broker' } });
    await act(async () => assignControl.onAssigned!({ id: 'agent-2', name: 'Bo Broker' }));
    await tab('Appointments');

    expect(requests()).toBe(2);
    expect(text()).toContain('With Bo Broker, the assigned agent.');
  });

  it('each time the modal is opened, it asks afresh', async () => {
    await open(lead());
    await close();
    await open(lead());

    expect(requests()).toBe(2);
  });

  it('shows the loading state, then the error, on whichever tab is open — without asking again', async () => {
    let fail!: (e: unknown) => void;
    api.bookingOptions.mockReturnValueOnce(new Promise((_, reject) => (fail = reject)));
    await open(lead());
    expect(text()).toContain('Loading booking options…');

    const failure = new Error('Calendar is unreachable');
    await act(async () => fail(failure));
    expect(text()).toContain(messageFor(failure));
    expect(text()).not.toContain('Loading booking options…');
    await tab('Appointments');
    expect(text()).toContain(messageFor(failure));

    expect(requests()).toBe(1);
  });

  it('a demo lead (no database id) never asks', async () => {
    await open(lead({ id: 'lead_1700000000000' }));
    await tab('Appointments');

    expect(requests()).toBe(0);
  });

  it('the panel used on its own (the agent lead screen) still reads its own options, once', async () => {
    await act(async () => root!.render(<LeadAppointments leadId={LEAD_ID} agentKey={null} />));

    expect(api.bookingOptions.mock.calls).toEqual([[LEAD_ID]]);
    expect(text()).toContain('Buyer consult · 30 min');
  });

  it('under StrictMode, switching tabs adds no requests', async () => {
    strict = true;
    await render();
    await open(lead());
    const afterOpen = requests();
    await tab('Appointments');
    await tab('Overview');
    await tab('Appointments');

    expect(requests()).toBe(afterOpen);
  });
});

describe('LeadDetailModal: SMS history', () => {
  const message = (over: Partial<MessageRow>): MessageRow => ({
    id: 'm', direction: 'outbound', senderType: 'ai', channel: 'sms', body: '', deliveryStatus: 'delivered',
    sentAt: null, deliveredAt: null, failedAt: null, createdAt: '2026-10-01T10:00:00.000Z', ...over,
  });

  it("reads all of the lead's texts in one request — never the thread list, never thread by thread", async () => {
    // Two threads' messages, as the server returns them: thread by thread,
    // each oldest first. The modal shows them as one timeline by time sent.
    history.leadMessages.mockResolvedValueOnce([
      message({ id: 'a1', body: 'Thread A, first', createdAt: '2026-10-01T10:00:00.000Z', sentAt: '2026-10-01T10:00:05.000Z' }),
      message({ id: 'a2', body: 'Thread A, reply', direction: 'inbound', senderType: 'lead', createdAt: '2026-10-03T09:00:00.000Z' }),
      message({ id: 'b1', body: 'Thread B, between', createdAt: '2026-10-02T08:00:00.000Z', deliveryStatus: 'failed' }),
    ]);
    await open(lead());

    expect(history.leadMessages.mock.calls).toEqual([[LEAD_ID]]);
    expect(history.calls.mock.calls).toEqual([[{ leadId: LEAD_ID, limit: 200 }]]);
    expect(history.conversations).not.toHaveBeenCalled();
    expect(history.threadMessages).not.toHaveBeenCalled();

    expect(text()).toContain('SMS (3)');
    await tab('SMS');
    const shown = text();
    const order = ['Thread A, first', 'Thread B, between', 'Thread A, reply'].map((b) => shown.indexOf(b));
    expect(order.every((at) => at >= 0)).toBe(true);
    expect(order).toEqual([...order].sort((x, y) => x - y));
    expect(shown).toContain('not delivered');
  });

  it('a lead with no texts shows the empty state', async () => {
    await open(lead());
    await tab('SMS');

    expect(text()).toContain('SMS (0)');
    expect(text()).toContain('No texts with this lead yet.');
  });

  it('a failed read shows the activity error', async () => {
    const failure = new Error('history unavailable');
    history.leadMessages.mockRejectedValueOnce(failure);
    await open(lead());
    await tab('SMS');

    expect(text()).toContain(`Could not load activity: ${messageFor(failure)}`);
  });

  it('a demo lead (no database id) asks for no history at all', async () => {
    await open(lead({ id: 'lead_1700000000000' }));

    expect(history.leadMessages).not.toHaveBeenCalled();
    expect(history.calls).not.toHaveBeenCalled();
  });
});
