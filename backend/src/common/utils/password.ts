import { randomBytes, randomInt, scrypt, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt) as (
  password: string,
  salt: Buffer,
  keyLength: number,
) => Promise<Buffer>;

const KEY_LENGTH:number = 64;
const SALT_LENGTH:number = 12;

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(SALT_LENGTH);
  const hash = await scryptAsync(password, salt, KEY_LENGTH);

  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

export async function verifyPassword(
  password: string,
  storedHash: string,
): Promise<boolean> {
  try {
    const [algorithm, saltHex, hashHex] = storedHash.split('$');

    if (algorithm !== 'scrypt' || !saltHex || !hashHex) {
      return false;
    }

    const salt = Buffer.from(saltHex, 'hex');
    const expectedHash = Buffer.from(hashHex, 'hex');

    if (!salt.length || !expectedHash.length) {
      return false;
    }

    const actualHash = await scryptAsync(
      password,
      salt,
      expectedHash.length,
    );

    if (actualHash.length !== expectedHash.length) {
      return false;
    }

    return timingSafeEqual(actualHash, expectedHash);
  } catch {
    return false;
  }
}

const UPPER = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
const LOWER = 'abcdefghijkmnopqrstuvwxyz';
const DIGITS = '23456789';
const SYMBOLS = '@#$%&*!?';
const ALL = UPPER + LOWER + DIGITS + SYMBOLS;


export function generatePassword(length = 12): string {
  if (length < 8) throw new Error('Generated passwords must be at least 8 characters');

  const pick = (set: string): string => set[randomInt(set.length)];
  const chars = [pick(UPPER), pick(LOWER), pick(DIGITS), pick(SYMBOLS)];
  while (chars.length < length) chars.push(pick(ALL));

  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join('');
}
