/**
 * JSON paths for an arbitrary payload — the half of the field mapper that has
 * no idea what a lead is.
 *
 * `flatten` turns a payload into leaves the owner can point at ("this is the
 * phone"); `valueAt` reads one of those paths back off a later payload. Both
 * must agree on the grammar, which is the usual one:
 *
 *   contact.phone          nested object keys
 *   data.fields[2].value   array index
 *   ["first name"].x       a key that is not a plain identifier
 *
 * Pure, bounded, no I/O.
 */

export type LeafType = 'string' | 'number' | 'boolean' | 'null' | 'list' | 'object' | 'empty';

export interface Leaf {
  path: string;
  /** The value as text — what a transform would receive. */
  value: string;
  type: LeafType;
}

/** Leaves a payload may yield; a CRM dump with more is cut here, not refused. */
export const MAX_LEAVES = 500;
/** Nesting deeper than this is kept as one JSON leaf rather than walked. */
export const MAX_DEPTH = 10;
/** A single value is clamped to this many characters. */
export const MAX_VALUE_CHARS = 2000;

const PLAIN_KEY = /^[A-Za-z_$][A-Za-z0-9_$-]*$/;

const isScalar = (v: unknown): boolean => v === null || v === undefined || typeof v !== 'object';

const clamp = (s: string): string => (s.length > MAX_VALUE_CHARS ? s.slice(0, MAX_VALUE_CHARS) : s);

/** One value as text, however it is shaped. */
export function textOf(v: unknown): { value: string; type: LeafType } {
  if (v === null || v === undefined) return { value: '', type: 'null' };
  if (typeof v === 'string') return { value: clamp(v), type: 'string' };
  if (typeof v === 'number') return { value: Number.isFinite(v) ? String(v) : '', type: 'number' };
  if (typeof v === 'boolean') return { value: v ? 'true' : 'false', type: 'boolean' };
  if (Array.isArray(v)) {
    if (v.length === 0) return { value: '', type: 'empty' };
    if (v.every(isScalar)) {
      return { value: clamp(v.filter((x) => x !== null && x !== undefined).map((x) => String(x)).join(', ')), type: 'list' };
    }
    return { value: clamp(safeJson(v)), type: 'list' };
  }
  const keys = Object.keys(v as object);
  if (keys.length === 0) return { value: '', type: 'empty' };
  return { value: clamp(safeJson(v)), type: 'object' };
}

function safeJson(v: unknown): string {
  try {
    return JSON.stringify(v) ?? '';
  } catch {
    return '';
  }
}

/** How a key is written in a path. */
export function segment(key: string | number): string {
  if (typeof key === 'number') return `[${key}]`;
  return PLAIN_KEY.test(key) ? key : `[${JSON.stringify(key)}]`;
}

function joinPath(tokens: (string | number)[]): string {
  let out = '';
  for (const t of tokens) {
    const s = segment(t);
    out += out && !s.startsWith('[') ? `.${s}` : s;
  }
  return out;
}

/**
 * Every leaf of a payload, in document order.
 *
 * An array of scalars yields one leaf for the whole list ("tags") AND one per
 * element ("tags[0]"), because either is a reasonable thing to map. An array of
 * objects is walked by index.
 */
export function flatten(payload: unknown): { leaves: Leaf[]; truncated: boolean } {
  const leaves: Leaf[] = [];
  let truncated = false;

  const push = (tokens: (string | number)[], v: unknown): void => {
    if (leaves.length >= MAX_LEAVES) {
      truncated = true;
      return;
    }
    const { value, type } = textOf(v);
    leaves.push({ path: joinPath(tokens), value, type });
  };

  const walk = (v: unknown, tokens: (string | number)[], depth: number): void => {
    if (truncated) return;
    if (isScalar(v) || depth > MAX_DEPTH) {
      if (tokens.length > 0) push(tokens, v);
      return;
    }
    if (Array.isArray(v)) {
      if (v.length === 0) {
        if (tokens.length > 0) push(tokens, v);
        return;
      }
      if (v.every(isScalar)) {
        if (tokens.length > 0) push(tokens, v);
        v.forEach((x, i) => push([...tokens, i], x));
        return;
      }
      v.forEach((x, i) => walk(x, [...tokens, i], depth + 1));
      return;
    }
    const obj = v as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) {
      if (tokens.length > 0) push(tokens, v);
      return;
    }
    for (const k of keys) walk(obj[k], [...tokens, k], depth + 1);
  };

  walk(payload, [], 0);
  return { leaves, truncated };
}

/** Path text -> tokens. Throws on a path the grammar cannot read. */
export function parsePath(path: string): (string | number)[] {
  const tokens: (string | number)[] = [];
  let i = 0;
  const n = path.length;
  if (n === 0) throw new Error('empty path');
  while (i < n) {
    const c = path[i];
    if (c === '.') {
      // A dot joins two named keys; nothing else may surround it.
      if (i === 0 || i + 1 >= n || path[i + 1] === '.' || path[i + 1] === '[') throw new Error(`path "${path}" has an empty segment`);
      i++;
      continue;
    }
    if (c === '[') {
      const close = path.indexOf(']', i);
      if (close === -1) throw new Error(`path "${path}" has an unclosed "["`);
      const inner = path.slice(i + 1, close);
      if (inner.startsWith('"')) {
        // A quoted key may itself contain "]" — find the closing quote properly.
        let j = i + 2;
        let key = '';
        for (;;) {
          if (j >= n) throw new Error(`path "${path}" has an unterminated quoted key`);
          if (path[j] === '\\' && j + 1 < n) {
            key += path[j + 1];
            j += 2;
            continue;
          }
          if (path[j] === '"') break;
          key += path[j];
          j++;
        }
        if (path[j + 1] !== ']') throw new Error(`path "${path}" has a quoted key not followed by "]"`);
        tokens.push(key);
        i = j + 2;
      } else {
        if (!/^\d+$/.test(inner)) throw new Error(`path "${path}" has a non-numeric index "${inner}"`);
        tokens.push(Number(inner));
        i = close + 1;
      }
      // After "]" only ".", another "[" or the end may follow.
      if (i < n && path[i] !== '.' && path[i] !== '[') throw new Error(`path "${path}" runs a key straight on after "]"`);
      continue;
    }
    let j = i;
    while (j < n && path[j] !== '.' && path[j] !== '[') j++;
    const key = path.slice(i, j);
    if (!PLAIN_KEY.test(key)) throw new Error(`path "${path}" has a key that must be quoted: ${key}`);
    tokens.push(key);
    i = j;
  }
  return tokens;
}

/** True when the grammar accepts the path. */
export function isValidPath(path: string): boolean {
  try {
    parsePath(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The value at a path, as text. `present` is false when the path points at
 * nothing — an optional field the sender left out — which is different from
 * a field sent as null or "".
 */
export function valueAt(payload: unknown, path: string): { value: string; type: LeafType; present: boolean } {
  let cur: unknown = payload;
  for (const t of parsePath(path)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return { value: '', type: 'null', present: false };
    if (typeof t === 'number') {
      if (!Array.isArray(cur) || t >= cur.length) return { value: '', type: 'null', present: false };
      cur = cur[t];
    } else {
      if (Array.isArray(cur) || !Object.prototype.hasOwnProperty.call(cur, t)) return { value: '', type: 'null', present: false };
      cur = (cur as Record<string, unknown>)[t];
    }
  }
  return { ...textOf(cur), present: true };
}
