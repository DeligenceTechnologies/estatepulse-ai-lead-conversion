import { describe, expect, it } from 'vitest';

import { sourceLabel } from './portal.controller';

/**
 * The badge answers "which form did this person fill in". Keying it off
 * `connectionMethod` once made every MANUAL source read "webhook", which hid a
 * Google Form — connected through Google, but delivering via a script the owner
 * installs — behind the name of its transport.
 */
const src = (provider: string, connectionMethod: string) => ({ provider, connectionMethod }) as never;

describe('portal lead source label', () => {
  it('names the product for a Google Form, even though it is wired up MANUAL', () => {
    expect(sourceLabel(src('GOOGLE_FORMS', 'MANUAL'))).toBe('google forms');
  });

  it('names the product for a form whose URL was pasted by hand', () => {
    expect(sourceLabel(src('TALLY', 'MANUAL'))).toBe('tally');
    expect(sourceLabel(src('TYPEFORM', 'API'))).toBe('typeform');
  });

  it('keeps "webhook" for the providers that really are just a webhook', () => {
    expect(sourceLabel(src('WEBHOOK', 'MANUAL'))).toBe('webhook');
    expect(sourceLabel(src('CUSTOM', 'MANUAL'))).toBe('webhook');
  });

  it('calls a lead with no source manual', () => {
    expect(sourceLabel(null)).toBe('manual');
  });
});
