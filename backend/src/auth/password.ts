import bcrypt from 'bcrypt';

const COST = 12;

/**
 * A real cost-12 hash of a random string. Compared against when an email is
 * unknown or a row has no password set, so login spends the same ~250ms either
 * way and response timing stops leaking which emails exist.
 */
const DUMMY_HASH = '$2b$12$l2Kq4dBAE27wr7PUUxLPQe4W8W7bv4EUhpc4ShrG3ecinWfihmKgC';

export const hashPassword = (plain: string): Promise<string> => bcrypt.hash(plain, COST);

/**
 * password_hash is nullable in the database, so a user row can legitimately
 * exist with no password. That is never a successful login, but it still burns
 * the comparison to keep the timing flat.
 */
export async function verifyPassword(plain: string, hash: string | null): Promise<boolean> {
  if (hash === null || hash.length === 0) {
    await bcrypt.compare(plain, DUMMY_HASH);
    return false;
  }
  return bcrypt.compare(plain, hash);
}

export const burnTiming = (plain: string): Promise<boolean> => bcrypt.compare(plain, DUMMY_HASH);
