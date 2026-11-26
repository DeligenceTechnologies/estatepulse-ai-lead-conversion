import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { AssistantAction } from '../../utils/assistantChatApi';
import { AssistantDock, dockHint } from './AssistantDock';
import { ApprovalCard, minutesLeft } from './ApprovalCard';
import { availabilityOf, chatStoreKey, readRememberedChat, rememberChat, upsertAction, type ChatMessage } from './AssistantProvider';
import { blocksOf, RichText } from './RichText';
import { greeting, starterPrompts, whenShort } from './starterPrompts';

const assistant = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('./AssistantProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./AssistantProvider')>();
  return { ...actual, useAssistant: () => assistant.current };
});
vi.mock('../../context/AuthContext', () => ({
  useAuth: () => ({ user: { firstName: 'Sarah' }, can: (p: string) => p === 'lead.read' }),
}));
vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Navigate: ({ to }: { to: string }) => createElement('i', { 'data-navigate': to }),
  };
});

const action = (over: Partial<AssistantAction> = {}): AssistantAction => ({
  id: 'act-1',
  messageId: 'msg-1',
  tool: 'lead_update',
  status: 'proposed',
  title: 'Update Maria Lopez',
  summary: null,
  changes: [{ field: 'First name', from: 'Maria', to: 'Mariah' }],
  error: null,
  expiresAt: new Date(Date.now() + 9.5 * 60_000).toISOString(),
  decidedAt: null,
  ...over,
});

const msg = (id: string, role: 'user' | 'assistant', text: string, actions: AssistantAction[] = []): ChatMessage => ({
  id,
  role,
  text,
  createdAt: '2026-11-25T10:00:00Z',
  actions,
});

describe('reply formatting', () => {
  it('turns "- " lines into a list and keeps the paragraphs around it', () => {
    expect(blocksOf('I found 3 hot leads:\n- Maria Lopez\n- James Carter\n\nWant me to assign them?')).toEqual([
      { kind: 'p', lines: ['I found 3 hot leads:'] },
      { kind: 'ul', items: ['Maria Lopez', 'James Carter'] },
      { kind: 'p', lines: ['Want me to assign them?'] },
    ]);
  });

  it('reads numbered lists too', () => {
    expect(blocksOf('1. Call Maria\n2. Text James')).toEqual([{ kind: 'ol', items: ['Call Maria', 'Text James'] }]);
  });

  it('shows **bold** as bold and escapes everything else', () => {
    const html = renderToString(<RichText text={'**3 hot leads** <script>x</script>'} />);
    expect(html).toContain('<strong class="font-semibold text-white">3 hot leads</strong>');
    expect(html).not.toContain('<script>');
  });
});

describe('the chat in the corner', () => {
  it('says how to use it: hold to speak only where the browser can listen', () => {
    expect(dockHint(true)).toBe('Tap to type · Hold to speak');
    expect(dockHint(false)).toBe('Tap to ask');
  });

  it('starts closed, as a button with its hint', () => {
    assistant.current = { availability: 'ready', messages: [], threads: [], busy: false, dockOpen: false, setDockOpen: () => undefined };
    const html = renderToString(
      <MemoryRouter>
        <AssistantDock screen="All Leads" />
      </MemoryRouter>,
    );
    expect(html).toContain('aria-label="Ask EstatePulse"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('Tap to ask'); // no speech recognition when rendered on the server
    expect(html).not.toContain('<section');
  });
});

describe('chat state', () => {
  it('puts a new card on the reply being written, and updates a known card in place', () => {
    const draft = { ...msg('draft', 'assistant', ''), pending: true };
    const withCard = upsertAction([msg('1', 'user', 'x'), draft], action());
    expect(withCard[1].actions).toHaveLength(1);
    const done = upsertAction(withCard, action({ status: 'executed' }));
    expect(done[1].actions).toEqual([expect.objectContaining({ id: 'act-1', status: 'executed' })]);
  });

  it('says why the assistant cannot be used', () => {
    const usage = { period: '2026-11', usedMicros: 0, budgetMicros: 1 };
    expect(availabilityOf(null)).toBe('loading');
    expect(availabilityOf({ enabled: false, included: true, usage })).toBe('off');
    expect(availabilityOf({ enabled: true, included: false, usage })).toBe('not_in_plan');
    expect(availabilityOf({ enabled: true, included: true, usage })).toBe('ready');
    // The user's roles lack assistant.use; an older server that does not say counts as allowed.
    expect(availabilityOf({ enabled: true, included: true, allowed: false, usage })).toBe('no_access');
    expect(availabilityOf({ enabled: true, included: true, allowed: true, usage })).toBe('ready');
  });
});

describe('the same chat everywhere', () => {
  const store = () => {
    const data = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, v),
      removeItem: (k: string) => void data.delete(k),
    });
    return data;
  };

  it('remembers the open chat per user, and forgets it on New chat', () => {
    const data = store();
    rememberChat(chatStoreKey('user-1'), 't-1');
    expect(readRememberedChat(chatStoreKey('user-1'))).toBe('t-1');
    expect(readRememberedChat(chatStoreKey('user-2'))).toBeNull();
    rememberChat(chatStoreKey('user-1'), null);
    expect(data.size).toBe(0);
    vi.unstubAllGlobals();
  });

  it('works without browser storage, it just does not remember', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
      removeItem: () => {
        throw new Error('blocked');
      },
    });
    expect(() => rememberChat(chatStoreKey('user-1'), 't-1')).not.toThrow();
    expect(readRememberedChat(chatStoreKey('user-1'))).toBeNull();
    vi.unstubAllGlobals();
  });
});

describe('ApprovalCard', () => {
  it('offers Approve and Cancel on an open card, with the time left', () => {
    const html = renderToString(<ApprovalCard action={action()} disabled={false} onDecide={() => undefined} />);
    expect(html).toContain('Approval needed');
    expect(html).toContain('Approve');
    expect(html).toContain('Cancel');
    expect(html).toMatch(/Expires in (9|10) min/);
    expect(html).toContain('Mariah');
  });

  it('shows the outcome, and no buttons, once decided', () => {
    const html = renderToString(<ApprovalCard action={action({ status: 'executed' })} disabled={false} onDecide={() => undefined} />);
    expect(html).toContain('Done');
    expect(html).not.toContain('Approve');
  });

  it('treats a card past its time as expired even before the server says so', () => {
    const html = renderToString(
      <ApprovalCard action={action({ expiresAt: new Date(Date.now() - 1000).toISOString() })} disabled={false} onDecide={() => undefined} />,
    );
    expect(html).toContain('Expired');
    expect(html).not.toContain('Approve');
    expect(minutesLeft(new Date(Date.now() - 1).toISOString())).toBeNull();
  });
});

describe('starter prompts', () => {
  it('gives owners and agents four ideas each, phrased for what they can see', () => {
    expect(starterPrompts(true)).toHaveLength(4);
    expect(starterPrompts(false)).toHaveLength(4);
    expect(starterPrompts(false)[0].title).toBe('Show my hot leads');
  });

  it('dates a chat briefly: time today, then Yesterday, then the weekday, then the date', () => {
    const now = new Date(2026, 10, 25, 15, 0);
    expect(whenShort(new Date(2026, 10, 25, 14, 27).toISOString(), now)).toMatch(/2:27/);
    expect(whenShort(new Date(2026, 10, 24, 9, 0).toISOString(), now)).toBe('Yesterday');
    expect(whenShort(new Date(2026, 10, 21, 9, 0).toISOString(), now)).toMatch(/Sat/);
    expect(whenShort(new Date(2026, 10, 2, 9, 0).toISOString(), now)).toMatch(/2/);
  });

  it('greets by the time of day', () => {
    expect(greeting(9)).toBe('Good morning');
    expect(greeting(14)).toBe('Good afternoon');
    expect(greeting(20)).toBe('Good evening');
  });
});

describe('AssistantHome', () => {
  const render = async () => {
    const { AssistantHome } = await import('./AssistantHome');
    return renderToString(
      <MemoryRouter initialEntries={['/assistant']}>
        <AssistantHome />
      </MemoryRouter>,
    );
  };
  const base = {
    dockOpen: false,
    setDockOpen: () => undefined,
    status: null,
    overBudget: false,
    threads: [],
    threadId: null,
    messages: [],
    busy: false,
    error: null,
    send: () => undefined,
    decide: () => undefined,
    openThread: async () => undefined,
    newChat: () => undefined,
    removeThread: async () => undefined,
    stop: () => undefined,
    dismissError: () => undefined,
  };

  it('sends someone who cannot use the assistant to the dashboard', async () => {
    assistant.current = { ...base, availability: 'off' };
    expect(await render()).toBe('<i data-navigate="/dashboard"></i>');
    assistant.current = { ...base, availability: 'not_in_plan' };
    expect(await render()).toBe('<i data-navigate="/dashboard"></i>');
  });

  it('greets the user and offers the starter ideas on an empty chat', async () => {
    assistant.current = { ...base, availability: 'ready' };
    const html = await render();
    expect(html).toContain('Sarah');
    expect(html).toContain('What can I help you with today?');
    expect(html).toContain('Which hot leads came in this week?');
  });

  it('shows the chat and its approval card once a conversation is open', async () => {
    assistant.current = {
      ...base,
      availability: 'ready',
      threadId: 't-1',
      threads: [{ id: 't-1', title: 'Hot leads this week', lastMessageAt: '2026-11-25T10:00:00Z', createdAt: '2026-11-25T10:00:00Z' }],
      messages: [msg('1', 'user', 'Rename Maria'), msg('2', 'assistant', 'Please check and approve.', [action()])],
    };
    const html = await render();
    expect(html).toContain('Hot leads this week');
    expect(html).toContain('Approval needed');
    expect(html).not.toContain('What can I help you with today?');
  });

  it('tells the user when this month\'s limit is used up', async () => {
    assistant.current = { ...base, availability: 'ready', overBudget: true };
    expect(await render()).toContain('limit for your plan is used up');
  });
});
