import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Root } from './Root';

/**
 * /terms and /privacy must be reachable without signing in.
 *
 * Every path Root does not list falls through `*` into RequireAuth, which sends
 * a visitor to /login, so dropping either route would turn the footer and
 * signup links into a login redirect. `Navigate` renders where it would go and
 * the shells are stand-ins, so the markup says exactly what mounted.
 */

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));
vi.mock('./context/AuthContext', () => ({ useAuth: () => auth.current }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Navigate: ({ to }: { to: string | { pathname?: string } }) =>
      createElement('i', { 'data-navigate': typeof to === 'string' ? to : (to.pathname ?? '') }),
  };
});

const { shell } = vi.hoisted(() => ({
  shell: async () => {
    const { createElement } = await import('react');
    return () => createElement('i', { 'data-shell': '' });
  },
}));
vi.mock('./App', async () => ({ default: await shell() }));
vi.mock('./components/agent/AgentApp', async () => ({ AgentApp: await shell() }));

const render = (url: string) =>
  renderToString(
    <MemoryRouter initialEntries={[url]}>
      <Root />
    </MemoryRouter>,
  );

const PAGES = [
  ['/terms', 'Terms &amp; Conditions</h1>'],
  ['/privacy', 'Privacy Policy</h1>'],
] as const;

describe.each(PAGES)('%s', (url, heading) => {
  it('renders for a signed-out visitor instead of redirecting to /login', () => {
    auth.current = { status: 'anon', role: null };
    const html = render(url);
    expect(html).toContain(heading);
    expect(html).not.toContain('data-navigate');
  });

  it('renders signed in too, without mounting the app shell', () => {
    auth.current = { status: 'authed', role: 'owner' };
    const html = render(url);
    expect(html).toContain(heading);
    expect(html).not.toContain('data-shell');
    expect(html).not.toContain('data-navigate');
  });
});

it('an unlisted path still sends a signed-out visitor to /login', () => {
  auth.current = { status: 'anon', role: null };
  expect(render('/dashboard')).toBe('<i data-navigate="/login"></i>');
});
