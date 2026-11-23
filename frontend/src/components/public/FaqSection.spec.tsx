import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { FAQ_ITEMS } from '../../content/faq';
import { FaqSection } from './FaqSection';

/** What React writes for the characters it escapes in text. */
const escaped = (s: string) => s.replace(/&/g, '&amp;').replace(/'/g, '&#x27;').replace(/"/g, '&quot;');

describe('FaqSection', () => {
  const html = renderToString(<FaqSection />);

  it('is the #faq anchor the footer links to', () => {
    expect(html).toContain('<section id="faq"');
  });

  it('has every question and every answer in the page, open or not', () => {
    for (const item of FAQ_ITEMS) {
      expect(html).toContain(escaped(item.question));
      expect(html).toContain(escaped(item.answer));
    }
  });

  it('starts with every answer closed', () => {
    expect(html.match(/aria-expanded="false"/g)).toHaveLength(FAQ_ITEMS.length);
    expect(html).not.toContain('aria-expanded="true"');
    expect(html.match(/role="region"[^>]* hidden=""/g)).toHaveLength(FAQ_ITEMS.length);
  });

  it('ties each question button to its own answer panel', () => {
    for (const item of FAQ_ITEMS) {
      expect(html).toContain(`id="faq-${item.id}-question"`);
      expect(html).toContain(`aria-controls="faq-${item.id}-answer"`);
      expect(html).toContain(`id="faq-${item.id}-answer"`);
      expect(html).toContain(`aria-labelledby="faq-${item.id}-question"`);
    }
  });

  it('item ids are unique, since element ids are built from them', () => {
    const ids = FAQ_ITEMS.map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
