import crypto from 'node:crypto';

/**
 * AES-256-GCM encryption for secrets at rest (tenant Telnyx API keys).
 * Key from ENCRYPTION_KEY (64 hex chars = 32 bytes). Format: iv.tag.ciphertext (base64).
 * With no key configured it passes through (dev only) so the app still boots.
 */
function getKey(): Buffer | null {
  const hex = process.env.ENCRYPTION_KEY ?? '';
  if (hex.length !== 64) return null;
  return Buffer.from(hex, 'hex');
}

export function encrypt(plain: string): string {
  const key = getKey();
  if (!key || plain == null) return plain;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('base64')}.${tag.toString('base64')}.${ct.toString('base64')}`;
}

export function decrypt(blob: string): string {
  const key = getKey();
  if (!key || !blob || typeof blob !== 'string' || !blob.includes('.')) return blob;
  try {
    const parts = blob.split('.');
    if (parts.length !== 3) return blob;
    const [iv, tag, ct] = parts.map((p) => Buffer.from(p, 'base64')) as [Buffer, Buffer, Buffer];
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(ct), decipher.final()]).toString('utf8');
  } catch {
    return blob;
  }
}
