import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'node:crypto';

/**
 * AES-256-GCM for the tenant Telnyx API keys held in `integrations`.
 *
 * This is deliberately NOT common/crypto.ts's SecretBox, which is the better
 * primitive — it binds ciphertext to its row with AAD and supports rotation.
 * The two exist because live rows are already encrypted under this scheme, and
 * switching would mean re-encrypting them: a data migration, not a refactor.
 * Folding this into SecretBox is worth doing, as a migration, with a backup.
 *
 * With no key configured it passes through so a fresh checkout still boots; the
 * warning below is the only thing standing between that and silently storing
 * provider keys in plaintext, so it is loud and it fires once at startup.
 */
@Injectable()
export class SecretCipherService {
  private readonly logger = new Logger(SecretCipherService.name);
  private readonly key: Buffer | null;

  constructor(config: ConfigService) {
    const hex = config.get<string>('ENCRYPTION_KEY') ?? '';
    this.key = hex.length === 64 ? Buffer.from(hex, 'hex') : null;

    if (!this.key) {
      this.logger.warn(
        'ENCRYPTION_KEY is missing or not 64 hex characters — provider API keys will be stored in PLAINTEXT. ' +
          'Generate one with: openssl rand -hex 32',
      );
    }
  }

  encrypt(plain: string): string {
    if (!this.key || plain == null) return plain;
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
    const tag = cipher.getAuthTag();
    return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
  }

  decrypt(blob: string): string {
    if (!this.key || !blob || typeof blob !== 'string' || !blob.includes('.')) return blob;
    try {
      const parts = blob.split('.');
      if (parts.length !== 3) return blob;
      const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
      const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, iv);
      decipher.setAuthTag(tag);
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
    } catch {
      // A value that predates the key, or was never encrypted at all.
      return blob;
    }
  }
}
