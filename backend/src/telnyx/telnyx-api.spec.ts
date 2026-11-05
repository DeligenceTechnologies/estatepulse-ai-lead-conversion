import { describe, expect, it } from 'vitest';
import { telnyxErrorText } from './telnyx-api';

describe('telnyxErrorText', () => {
  it('turns the provider JSON into one readable line', () => {
    const body = JSON.stringify({
      errors: [{ code: '40310', title: "Invalid 'to' address", detail: "The 'to' address should be a single valid number.", meta: { url: 'https://developers.telnyx.com/docs/overview/errors/40310' } }],
    });
    expect(telnyxErrorText(body)).toBe("Invalid 'to' address — The 'to' address should be a single valid number. (40310)");
  });

  it('joins several errors and copes with partial ones', () => {
    const body = JSON.stringify({ errors: [{ title: 'Unauthorized', code: '10009' }, { detail: 'Rate limit exceeded' }] });
    expect(telnyxErrorText(body)).toBe('Unauthorized (10009); Rate limit exceeded');
  });

  it('keeps plain text or an empty body understandable', () => {
    expect(telnyxErrorText('Bad Gateway')).toBe('Bad Gateway');
    expect(telnyxErrorText('   ')).toBe('no details (HTTP body empty)');
    expect(telnyxErrorText('{"errors":[]}')).toBe('{"errors":[]}');
  });
});
