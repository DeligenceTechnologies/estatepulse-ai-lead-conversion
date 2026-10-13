import { randomBytes } from 'node:crypto';
import type { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import type { IntegrationEnv } from '@/common/utils/interface';
import { SecretBoxService } from './secret-box.service';

const boxWith = (key?: string) =>
  new SecretBoxService({ get: () => key } as unknown as ConfigService<IntegrationEnv, true>);

describe('SecretBoxService', () => {
  const key = randomBytes(32).toString('base64');

  it('round-trips a secret and never stores it in the clear', () => {
    const box = boxWith(key);
    const sealed = box.seal('cal_live_secret');
    expect(sealed).not.toContain('cal_live_secret');
    expect(box.open(sealed)).toBe('cal_live_secret');
  });

  it('rejects tampered ciphertext', () => {
    const box = boxWith(key);
    const [version, iv, tag, data] = box.seal('token').split('.');
    const flipped = Buffer.from(data, 'base64url');
    flipped[0] ^= 1;
    expect(() => box.open([version, iv, tag, flipped.toString('base64url')].join('.'))).toThrow();
  });

  it('cannot open a secret sealed with another key', () => {
    const sealed = boxWith(key).seal('token');
    expect(() => boxWith(randomBytes(32).toString('base64')).open(sealed)).toThrow();
  });

  it('is disabled without a key and refuses a key of the wrong length', () => {
    expect(boxWith(undefined).enabled).toBe(false);
    expect(() => boxWith(undefined).seal('x')).toThrow(/INTEGRATION_ENCRYPTION_KEY/);
    expect(() => boxWith(randomBytes(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
