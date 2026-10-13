import { createHash, randomBytes } from 'node:crypto';
import type { SecretBox } from '../../common/crypto';

/**
 * The `state` parameter of a Google authorization, and its PKCE pair.
 *
 * The state is a SecretBox envelope, not a random id looked up in a table. It
 * carries everything completion needs to check, sealed so the browser — which
 * round-trips it through Google — can neither read nor alter it:
 *
 *  - org / usr / sid: who started it. Completion runs behind SessionGuard and
 *    refuses unless the caller is the SAME user in the SAME organization on the
 *    SAME session. That is what defeats login substitution: an attacker who
 *    starts a flow in their own org and lures a victim through Google cannot
 *    complete it, because the completing request has to carry the attacker's
 *    session token.
 *  - nonce: single-use, enforced by the caller.
 *  - exp: a short window, so a leaked state is worthless soon.
 *  - cv: the PKCE code_verifier. Google binds the code to its challenge, so a
 *    code minted for any other authorization request is rejected at exchange.
 *
 * The AAD is fixed and unique to this purpose, so no other SecretBox ciphertext
 * in the system (signing secrets, provider credentials) can be replayed as a
 * state, and a state cannot be decrypted as one of those.
 */

const STATE_AAD = 'google_sheets:oauth_state:v1';

/** Long enough to read a consent screen, short enough that a leaked state dies fast. */
export const STATE_TTL_MS = 10 * 60 * 1000;

export interface OAuthState {
  v: 1;
  org: string;
  usr: string;
  sid: string;
  nonce: string;
  exp: number;
  cv: string;
}

export function sealState(
  box: SecretBox,
  who: { organizationId: string; userId: string; sessionId: string },
  now = Date.now(),
): { state: string; codeChallenge: string; payload: OAuthState } {
  const cv = randomBytes(32).toString('base64url');
  const payload: OAuthState = {
    v: 1,
    org: who.organizationId,
    usr: who.userId,
    sid: who.sessionId,
    nonce: randomBytes(16).toString('base64url'),
    exp: now + STATE_TTL_MS,
    cv,
  };
  return {
    state: box.encrypt(JSON.stringify(payload), STATE_AAD),
    codeChallenge: createHash('sha256').update(cv).digest('base64url'),
    payload,
  };
}

/**
 * Null for anything that is not a state we sealed: tampered, truncated, sealed
 * under another purpose, or the wrong shape. Expiry is the caller's check, so it
 * can say "expired" rather than "invalid".
 */
export function openState(box: SecretBox, state: string): OAuthState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(box.decrypt(state, STATE_AAD));
  } catch {
    return null;
  }
  const p = parsed as Partial<OAuthState> | null;
  if (
    !p ||
    p.v !== 1 ||
    typeof p.org !== 'string' ||
    typeof p.usr !== 'string' ||
    typeof p.sid !== 'string' ||
    typeof p.nonce !== 'string' ||
    typeof p.exp !== 'number' ||
    typeof p.cv !== 'string'
  ) {
    return null;
  }
  return p as OAuthState;
}
