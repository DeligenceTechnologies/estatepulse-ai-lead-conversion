import { createHash, randomBytes } from 'node:crypto';
import type { SecretBoxService } from '@/common/service/secret-box.service';

type Box = Pick<SecretBoxService, 'seal' | 'open'>;

const STATE_AAD = 'google_sheets:oauth_state:v1';

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
  box: Box,
  who: { organizationId: string; userId: string; sessionId: string },
  now = Date.now(),
  /** Binds the state to one provider's flow; Google's by default. */
  stateAad = STATE_AAD,
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
    state: box.seal(JSON.stringify(payload), stateAad),
    codeChallenge: createHash('sha256').update(cv).digest('base64url'),
    payload,
  };
}

export function openState(box: Box, state: string, stateAad = STATE_AAD): OAuthState | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(box.open(state, stateAad));
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
