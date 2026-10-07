import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import { Root } from './Root';

/**
 * Which tree each URL mounts, per auth state.
 *
 * The shells and pages are stand-ins and `Navigate` renders where it would go,
 * so the markup says exactly what mounted. The case that matters: a signed-in
 * user at `/` must be redirected BEFORE any shell mounts. `/` and the `*` route
 * are different elements, so a shell mounted at `/` is thrown away and mounted
 * again at `/dashboard` — every boot request twice.
 */

const auth = vi.hoisted(() => ({ current: {} as Record<string, unknown> }));

vi.mock('./context/AuthContext', () => ({ useAuth: () => auth.current }));

vi.mock('react-router-dom', async (importOriginal) => {
  const actual = await importOriginal<typeof import('react-router-dom')>();
  const { createElement } = await import('react');
  return {
    ...actual,
    Navigate: ({ to }: { to: string | { pathname?: string; search?: string } }) =>
      createElement('i', { 'data-navigate': typeof to === 'string' ? to : `${to.pathname ?? ''}${to.search ?? ''}` }),
  };
});

const { marker } = vi.hoisted(() => ({
  marker: async (attr: string) => {
    const { createElement } = await import('react');
    return () => createElement('i', { [attr]: '' });
  },
}));
vi.mock('./App', async () => ({ default: await marker('data-owner-shell') }));
vi.mock('./components/agent/AgentApp', async () => ({ AgentApp: await marker('data-agent-shell') }));
vi.mock('./components/public/LandingPage', async () => ({ LandingPage: await marker('data-landing') }));
vi.mock('./components/auth/LoginPage', async () => ({ LoginPage: await marker('data-login') }));
vi.mock('./components/auth/SignupPage', async () => ({ SignupPage: await marker('data-signup') }));

const as = (status: string, role: string | null = null) => {
  auth.current = { status, role, explicitLogout: false };
};
const render = (url: string) =>
  renderToString(
    <MemoryRouter initialEntries={[url]}>
      <Root />
    </MemoryRouter>,
  );

describe('Root routing', () => {
  it('signed-out `/` is the landing page', () => {
    as('anon');
    expect(render('/')).toBe('<i data-landing=""></i>');
  });

  it('`/` renders nothing while the session is being restored', () => {
    as('loading');
    expect(render('/')).toBe('');
  });

  it('signed-in owner at `/` is redirected to /dashboard without mounting the app', () => {
    as('authed', 'owner');
    const html = render('/');
    expect(html).toBe('<i data-navigate="/dashboard"></i>');
    expect(html).not.toContain('data-owner-shell');
  });

  it('signed-in agent at `/` is redirected to /dashboard without mounting the agent shell', () => {
    as('authed', 'agent');
    const html = render('/');
    expect(html).toBe('<i data-navigate="/dashboard"></i>');
    expect(html).not.toContain('data-agent-shell');
  });

  it('the redirect keeps the query string (the Calendly fallback lands on /?calendly=)', () => {
    as('authed', 'owner');
    expect(render('/?calendly=connected')).toBe('<i data-navigate="/dashboard?calendly=connected"></i>');
  });

  it('/dashboard mounts the role\'s shell', () => {
    as('authed', 'owner');
    expect(render('/dashboard')).toBe('<i data-owner-shell=""></i>');
    as('authed', 'agent');
    expect(render('/dashboard')).toBe('<i data-agent-shell=""></i>');
  });

  it('signed-out /dashboard still goes to /login; /login and /signup still render', () => {
    as('anon');
    expect(render('/dashboard')).toBe('<i data-navigate="/login"></i>');
    expect(render('/login')).toBe('<i data-login=""></i>');
    expect(render('/signup')).toBe('<i data-signup=""></i>');
  });
});
