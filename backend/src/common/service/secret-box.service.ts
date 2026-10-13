import { Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import type { IntegrationEnv } from '@/common/utils/interface';

const ALGORITHM = 'aes-256-gcm';
const VERSION = 'v1';
const IV_BYTES = 12;

@Injectable()
export class SecretBoxService {
  private readonly key?: Buffer;

  constructor(config: ConfigService<IntegrationEnv, true>) {
    const raw = config.get('INTEGRATION_ENCRYPTION_KEY', { infer: true });
    const key = raw ? Buffer.from(raw, 'base64') : undefined;
    if (key && key.length !== 32) {
      throw new Error('INTEGRATION_ENCRYPTION_KEY must be 32 bytes, base64-encoded (openssl rand -base64 32)');
    }
    this.key = key;
  }

  get enabled(): boolean {
    return this.key !== undefined;
  }

  seal(plaintext: string): string {
    const key = this.requireKey();
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv(ALGORITHM, key, iv);
    const data = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const parts = [iv, cipher.getAuthTag(), data].map((part) => part.toString('base64url'));
    return [VERSION, ...parts].join('.');
  }

  open(sealed: string): string {
    const key = this.requireKey();
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== VERSION || !iv || !tag || data === undefined) {
      throw new Error('Unrecognised sealed secret');
    }
    const decipher = createDecipheriv(ALGORITHM, key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    return Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]).toString('utf8');
  }

  private requireKey(): Buffer {
    if (!this.key) {
      throw new ServiceUnavailableException('Integrations are not configured on this server (INTEGRATION_ENCRYPTION_KEY is missing).');
    }
    return this.key;
  }
}
