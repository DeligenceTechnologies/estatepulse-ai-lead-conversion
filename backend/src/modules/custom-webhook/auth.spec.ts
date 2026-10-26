import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { authHeaderName, safeEqual, verifyCustomAuth, type CustomAuth } from './auth';

const body = Buffer.from('{"name":"Ann","phone":"+15125550101"}');
const SECRET = 'whsec_current';
const OLD = 'whsec_previous';
const secrets = { current: SECRET, previous: OLD };
const noPrevious = { current: SECRET, previous: null };

const hmac = (alg: 'sha256' | 'sha1', secret: string, enc: 'hex' | 'base64', raw = body) => createHmac(alg, secret).update(raw).digest(enc);

describe('verifyCustomAuth', () => {
  it('mode none accepts anything', () => {
    expect(verifyCustomAuth({ mode: 'none' }, { current: null, previous: null }, body, {})).toEqual({ ok: true, usedPrevious: false });
  });

  describe('header_secret', () => {
    const auth: CustomAuth = { mode: 'header_secret', headerName: 'x-webhook-secret' };
    it('matches the configured header, whatever case the name was given in', () => {
      expect(verifyCustomAuth({ ...auth, headerName: 'X-Webhook-Secret' }, noPrevious, body, { 'x-webhook-secret': SECRET })).toEqual({ ok: true, usedPrevious: false });
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-webhook-secret': ` ${SECRET} ` })).toMatchObject({ ok: true });
    });
    it('rejects a wrong value and reports a missing one', () => {
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-webhook-secret': 'nope' })).toEqual({ ok: false, reason: 'invalid_signature' });
      expect(verifyCustomAuth(auth, noPrevious, body, {})).toEqual({ ok: false, reason: 'signature_required' });
    });
    it('accepts the previous secret while it is still valid, and says so', () => {
      expect(verifyCustomAuth(auth, secrets, body, { 'x-webhook-secret': OLD })).toEqual({ ok: true, usedPrevious: true });
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-webhook-secret': OLD })).toEqual({ ok: false, reason: 'invalid_signature' });
    });
    it('fails closed when the mode needs a secret and none is stored', () => {
      expect(verifyCustomAuth(auth, { current: null, previous: null }, body, { 'x-webhook-secret': SECRET })).toEqual({ ok: false, reason: 'signature_required' });
    });
    it('reads the first value of a repeated header', () => {
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-webhook-secret': [SECRET, 'other'] })).toMatchObject({ ok: true });
    });
  });

  describe('hmac', () => {
    const base: CustomAuth = { mode: 'hmac', headerName: 'x-signature', algorithm: 'sha256', encoding: 'hex' };
    it('verifies sha256/hex over the raw bytes, with or without a prefix, in either case', () => {
      const sig = hmac('sha256', SECRET, 'hex');
      expect(verifyCustomAuth(base, noPrevious, body, { 'x-signature': sig })).toMatchObject({ ok: true });
      expect(verifyCustomAuth(base, noPrevious, body, { 'x-signature': sig.toUpperCase() })).toMatchObject({ ok: true });
      expect(verifyCustomAuth({ ...base, prefix: 'sha256=' }, noPrevious, body, { 'x-signature': `sha256=${sig}` })).toMatchObject({ ok: true });
      // The prefix is optional on the wire.
      expect(verifyCustomAuth({ ...base, prefix: 'sha256=' }, noPrevious, body, { 'x-signature': sig })).toMatchObject({ ok: true });
    });
    it('verifies sha1/base64', () => {
      const auth: CustomAuth = { ...base, algorithm: 'sha1', encoding: 'base64' };
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-signature': hmac('sha1', SECRET, 'base64') })).toMatchObject({ ok: true });
      expect(verifyCustomAuth(auth, noPrevious, body, { 'x-signature': hmac('sha256', SECRET, 'base64') })).toEqual({ ok: false, reason: 'invalid_signature' });
    });
    it('rejects a wrong secret, a tampered body and a missing header', () => {
      expect(verifyCustomAuth(base, noPrevious, body, { 'x-signature': hmac('sha256', 'wrong', 'hex') })).toEqual({ ok: false, reason: 'invalid_signature' });
      expect(verifyCustomAuth(base, noPrevious, Buffer.from('{"name":"Bob"}'), { 'x-signature': hmac('sha256', SECRET, 'hex') })).toEqual({ ok: false, reason: 'invalid_signature' });
      expect(verifyCustomAuth(base, noPrevious, body, {})).toEqual({ ok: false, reason: 'signature_required' });
    });
    it('accepts a signature made with the previous secret during the grace window', () => {
      expect(verifyCustomAuth(base, secrets, body, { 'x-signature': hmac('sha256', OLD, 'hex') })).toEqual({ ok: true, usedPrevious: true });
    });
  });

  describe('basic', () => {
    const auth: CustomAuth = { mode: 'basic', username: 'zapier' };
    const header = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString('base64')}`;
    it('verifies user and password', () => {
      expect(verifyCustomAuth(auth, noPrevious, body, { authorization: header('zapier', SECRET) })).toMatchObject({ ok: true });
      expect(verifyCustomAuth(auth, noPrevious, body, { authorization: header('zapier', 'wrong') })).toEqual({ ok: false, reason: 'invalid_signature' });
      expect(verifyCustomAuth(auth, noPrevious, body, { authorization: header('other', SECRET) })).toEqual({ ok: false, reason: 'invalid_signature' });
    });
    it('reports a missing or non-basic Authorization header as required', () => {
      expect(verifyCustomAuth(auth, noPrevious, body, {})).toEqual({ ok: false, reason: 'signature_required' });
      expect(verifyCustomAuth(auth, noPrevious, body, { authorization: 'Bearer abc' })).toEqual({ ok: false, reason: 'signature_required' });
    });
    it('splits at the first colon, so a password may contain one', () => {
      const colon = { current: 'a:b:c', previous: null };
      expect(verifyCustomAuth(auth, colon, body, { authorization: header('zapier', 'a:b:c') })).toMatchObject({ ok: true });
    });
    it('rejects garbage after the scheme', () => {
      expect(verifyCustomAuth(auth, noPrevious, body, { authorization: 'Basic ####' })).toEqual({ ok: false, reason: 'invalid_signature' });
    });
  });

  it('names the header each mode reads, so the stored copy can redact it', () => {
    expect(authHeaderName({ mode: 'none' })).toBeNull();
    expect(authHeaderName({ mode: 'basic', username: 'u' })).toBe('authorization');
    expect(authHeaderName({ mode: 'header_secret', headerName: 'X-Secret' })).toBe('x-secret');
  });

  it('safeEqual handles unequal lengths without throwing', () => {
    expect(safeEqual('a', 'abc')).toBe(false);
    expect(safeEqual('same', 'same')).toBe(true);
  });
});
