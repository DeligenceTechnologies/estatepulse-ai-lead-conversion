import { v7 as uuidv7 } from 'uuid';

/**
 * Application-generated primary keys.
 *
 * We generate ids in app code rather than using Postgres `gen_random_uuid()`
 * for two reasons:
 *
 *  1. UUIDv7 is time-ordered. `webhook_events` is by far the highest-insert-rate
 *     table in this system, and v4's randomness scatters B-tree inserts across
 *     the whole index, dirtying pages everywhere. v7 keeps inserts in the
 *     right-hand pages, which also makes the BRIN indexes on `received_at` /
 *     `created_at` effective because physical order tracks time order.
 *
 *  2. We need the id *before* the INSERT. The encryption AAD binds a ciphertext
 *     to its row id, and `Lead.identityKey` falls back to `'l:' + id` for leads
 *     with neither phone nor email. Both are impossible with a DB-generated
 *     default.
 */
export function newId(): string {
  return uuidv7();
}
