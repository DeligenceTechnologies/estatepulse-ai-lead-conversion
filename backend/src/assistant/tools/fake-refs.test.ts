import { vi } from 'vitest';
import { AppError } from '@/common/errors/app-error';
import { REF_LETTER, type RefKind, type RefTable } from './refs';

/**
 * Test helper (the .test.ts suffix keeps it out of the build and out of the test run).
 * A chat's refs kept in memory: numbered per kind in the order issued; anything else is NOT_FOUND.
 */
export function fakeRefs(): RefTable & { idOf(ref: string): string | undefined } {
  const refs = new Map<string, string>();
  const ids = new Map<string, string>();
  const counts: Record<string, number> = {};
  return {
    idOf: (ref) => ids.get(ref),
    issue: vi.fn(async (kind: RefKind, list: readonly string[]) => {
      const out = new Map<string, string>();
      for (const id of list) {
        let ref = refs.get(`${kind}:${id}`);
        if (!ref) {
          ref = `${REF_LETTER[kind]}${(counts[kind] = (counts[kind] ?? 0) + 1)}`;
          refs.set(`${kind}:${id}`, ref);
          ids.set(ref, id);
        }
        out.set(id, ref);
      }
      return out;
    }),
    resolve: vi.fn(async (kind: RefKind, ref: string) => {
      const id = ref.startsWith(REF_LETTER[kind]) ? ids.get(ref) : undefined;
      if (!id) throw new AppError('NOT_FOUND', `${ref} is not from this chat.`);
      return id;
    }),
  };
}
