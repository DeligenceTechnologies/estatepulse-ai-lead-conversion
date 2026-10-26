import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/**
 * How an inbound custom delivery proves it came from the app the owner set up.
 *
 * Four modes, chosen per source and stored (non-secret parts) in
 * lead_sources.custom_config. The secret itself — the shared header value, the
 * HMAC key or the basic-auth password — lives in signing_secret_enc, encrypted
 * and AAD-bound exactly like a Tally signing secret, and a rotation keeps the
 * previous one valid for its grace window.
 *
 * Every comparison is constant-time over a digest, so neither the length nor
 * the bytes of a secret leak through timing.
 */

export type CustomAuth =
  | { mode: 'none' }
  | { mode: 'header_secret'; headerName: string }
  | {
      mode: 'hmac';
      headerName: string;
      algorithm: 'sha256' | 'sha1';
      encoding: 'hex' | 'base64';
      /** Text before the digest in the header, e.g. "sha256=". */
      prefix?: string;
    }
  | { mode: 'basic'; username: string };

/** lead_sources.custom_config. */
export interface CustomConfig {
  auth: CustomAuth;
  /** Header whose value is the sender's delivery id, for idempotency. Lowercase. */
  deliveryIdHeader?: string;
  /** Deliveries dropped at the held-backlog cap while the source was unmapped. */
  dropped?: number;
}

export const needsSecret = (auth: CustomAuth): boolean => auth.mode !== 'none';

export type AuthVerdict =
  | { ok: true; usedPrevious: boolean }
  | { ok: false; reason: 'signature_required' | 'invalid_signature' };

/** First value of a header, however the framework delivered it. */
export function headerValue(headers: Record<string, unknown>, name: string): string | null {
  const v = headers[name.toLowerCase()];
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

/** Equal, in constant time, whatever the lengths. */
export function safeEqual(a: string, b: string): boolean {
  const da = createHash('sha256').update(a, 'utf8').digest();
  const db = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(da, db);
}

function hmacOf(algorithm: 'sha256' | 'sha1', secret: string, rawBody: Buffer, encoding: 'hex' | 'base64'): string {
  return createHmac(algorithm, secret).update(rawBody).digest(encoding);
}

function matches(auth: CustomAuth, secret: string, rawBody: Buffer, headers: Record<string, unknown>): boolean | 'missing' {
  switch (auth.mode) {
    case 'none':
      return true;
    case 'header_secret': {
      const v = headerValue(headers, auth.headerName);
      if (v === null) return 'missing';
      return safeEqual(v.trim(), secret);
    }
    case 'hmac': {
      const v = headerValue(headers, auth.headerName);
      if (v === null) return 'missing';
      let provided = v.trim();
      if (auth.prefix && provided.toLowerCase().startsWith(auth.prefix.toLowerCase())) provided = provided.slice(auth.prefix.length);
      const expected = hmacOf(auth.algorithm, secret, rawBody, auth.encoding);
      // Hex is case-insensitive; base64 is not.
      return auth.encoding === 'hex' ? safeEqual(provided.toLowerCase(), expected.toLowerCase()) : safeEqual(provided, expected);
    }
    case 'basic': {
      const v = headerValue(headers, 'authorization');
      if (v === null || !/^basic\s/i.test(v)) return 'missing';
      let decoded: string;
      try {
        decoded = Buffer.from(v.replace(/^basic\s+/i, '').trim(), 'base64').toString('utf8');
      } catch {
        return false;
      }
      const colon = decoded.indexOf(':');
      if (colon === -1) return false;
      const user = decoded.slice(0, colon);
      const pass = decoded.slice(colon + 1);
      // Both compared, always, so a wrong username costs the same time as a wrong password.
      const userOk = safeEqual(user, auth.username);
      const passOk = safeEqual(pass, secret);
      return userOk && passOk;
    }
  }
}

/**
 * Verify one delivery. `secrets.current` is null when the source has no secret
 * configured although its mode needs one — treated as "required and missing",
 * never as "accept".
 */
export function verifyCustomAuth(
  auth: CustomAuth,
  secrets: { current: string | null; previous: string | null },
  rawBody: Buffer,
  headers: Record<string, unknown>,
): AuthVerdict {
  if (auth.mode === 'none') return { ok: true, usedPrevious: false };
  if (!secrets.current) return { ok: false, reason: 'signature_required' };

  const current = matches(auth, secrets.current, rawBody, headers);
  if (current === 'missing') return { ok: false, reason: 'signature_required' };
  if (current) return { ok: true, usedPrevious: false };

  if (secrets.previous && matches(auth, secrets.previous, rawBody, headers) === true) {
    return { ok: true, usedPrevious: true };
  }
  return { ok: false, reason: 'invalid_signature' };
}

/** The header the auth mode reads, so the stored copy of the headers can redact it. */
export function authHeaderName(auth: CustomAuth): string | null {
  switch (auth.mode) {
    case 'none':
      return null;
    case 'basic':
      return 'authorization';
    default:
      return auth.headerName.toLowerCase();
  }
}
