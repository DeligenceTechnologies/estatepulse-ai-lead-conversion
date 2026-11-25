import { renderToString } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';
import type { LegalDocument } from '../../content/legal';
import { PRIVACY } from '../../content/privacy';
import { TERMS } from '../../content/terms';
import { LegalPage } from './LegalPage';
import { PrivacyPage } from './PrivacyPage';
import { TermsPage } from './TermsPage';

const auth = vi.hoisted(() => ({ current: { status: 'anon' } as Record<string, unknown> }));
vi.mock('../../context/AuthContext', () => ({ useAuth: () => auth.current }));

const render = (node: React.ReactNode) => renderToString(<MemoryRouter>{node}</MemoryRouter>);

const DOCS: Array<[string, LegalDocument]> = [
  ['Terms', TERMS],
  ['Privacy', PRIVACY],
];

describe.each(DOCS)('%s document', (_name, doc) => {
  const html = render(<LegalPage doc={doc} related={{ to: '/other', label: 'Other' }} />);

  it('section ids are unique', () => {
    const ids = doc.sections.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('no section, paragraph or list is empty', () => {
    for (const section of doc.sections) {
      expect(section.heading.trim()).not.toBe('');
      expect(section.body.length).toBeGreaterThan(0);
      for (const block of section.body) {
        if (typeof block === 'string') expect(block.trim()).not.toBe('');
        else expect(block.length).toBeGreaterThan(0);
      }
    }
  });

  it('every table-of-contents link points at a section that is rendered', () => {
    for (const section of doc.sections) {
      expect(html).toContain(`href="#${section.id}"`);
      expect(html).toContain(`<section id="${section.id}"`);
    }
  });
});

describe('legal pages', () => {
  it('/terms shows the terms and links to the privacy policy', () => {
    const html = render(<TermsPage />);
    expect(html).toContain('Terms &amp; Conditions</h1>');
    expect(html).toContain('href="/privacy"');
  });

  it('/privacy shows the policy and links to the terms', () => {
    const html = render(<PrivacyPage />);
    expect(html).toContain('Privacy Policy</h1>');
    expect(html).toContain('href="/terms"');
  });

  it('the nav links to the FAQ and the terms, and the footer to both legal pages', () => {
    const html = render(<TermsPage />);
    expect(html).toContain('href="/#faq"');
    expect(html).toContain('href="/terms"');
    expect(html).toContain('href="/privacy"');
  });

  it('the header offers sign-in to a visitor and the dashboard to someone signed in', () => {
    auth.current = { status: 'anon' };
    const anon = render(<TermsPage />);
    expect(anon).toContain('Get started');
    expect(anon).not.toContain('Go to dashboard');

    auth.current = { status: 'authed' };
    const authed = render(<TermsPage />);
    expect(authed).toContain('Go to dashboard');
    expect(authed).not.toContain('Get started');

    auth.current = { status: 'anon' };
  });
});
