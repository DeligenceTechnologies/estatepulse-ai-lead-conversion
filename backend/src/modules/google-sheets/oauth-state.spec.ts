import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { SecretBox, providerCredentialAad } from '../../common/crypto';
import { STATE_TTL_MS, openState, sealState } from './oauth-state';

const KEYS = JSON.stringify({ k1: Buffer.alloc(32, 7).toString('base64') });
const box = new SecretBox(KEYS, 'k1');
const WHO = { organizationId: 'org-1', userId: 'user-1', sessionId: 'sess-1' };

describe('OAuth state', () => {
  it('round-trips who started it, a short expiry and the PKCE verifier', () => {
    const now = 1_700_000_000_000;
    const { state, codeChallenge } = sealState(box, WHO, now);
    const p = openState(box, state)!;

    expect(p).toMatchObject({ v: 1, org: 'org-1', usr: 'user-1', sid: 'sess-1', exp: now + STATE_TTL_MS });
    expect(codeChallenge).toBe(createHash('sha256').update(p.cv).digest('base64url'));
  });

  it('is opaque to the browser: nothing it carries appears in the clear', () => {
    const { state, payload } = sealState(box, WHO);
    expect(state).not.toContain('org-1');
    expect(state).not.toContain(payload.cv);
  });

  it('rejects a tampered state', () => {
    const { state } = sealState(box, WHO);
    const tampered = state.slice(0, -2) + (state.endsWith('A') ? 'BB' : 'AA');
    expect(openState(box, tampered)).toBeNull();
  });

  it('rejects ciphertext sealed for another purpose, such as a stored credential', () => {
    const credential = box.encrypt(JSON.stringify({ v: 1 }), providerCredentialAad('org-1', 'cred-1'));
    expect(openState(box, credential)).toBeNull();
    expect(openState(box, 'not-an-envelope')).toBeNull();
  });

  it('rejects a state sealed under a key this server does not hold', () => {
    const other = new SecretBox(JSON.stringify({ k9: Buffer.alloc(32, 9).toString('base64') }), 'k9');
    expect(openState(box, sealState(other, WHO).state)).toBeNull();
  });
});
