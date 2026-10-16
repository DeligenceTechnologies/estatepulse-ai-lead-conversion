import { describe, expect, it } from 'vitest';
import { MAX_LEAVES, MAX_VALUE_CHARS, flatten, parsePath, segment, valueAt } from './flatten';

const payload = {
  contact: { phone: '+1 512 555 0101', tags: ['buyer', 'hot'] },
  data: { fields: [{ value: 'x' }, { value: 'y' }] },
  'first name': 'Ann',
  n: 3,
  ok: true,
  none: null,
  empty: {},
  list: [],
};

describe('flatten', () => {
  it('walks nested objects and arrays with the usual path grammar', () => {
    const { leaves, truncated } = flatten(payload);
    expect(truncated).toBe(false);
    expect(Object.fromEntries(leaves.map((l) => [l.path, l.value]))).toEqual({
      'contact.phone': '+1 512 555 0101',
      'contact.tags': 'buyer, hot',
      'contact.tags[0]': 'buyer',
      'contact.tags[1]': 'hot',
      'data.fields[0].value': 'x',
      'data.fields[1].value': 'y',
      '["first name"]': 'Ann',
      n: '3',
      ok: 'true',
      none: '',
      empty: '',
      list: '',
    });
    expect(Object.fromEntries(leaves.map((l) => [l.path, l.type]))).toMatchObject({
      'contact.phone': 'string',
      'contact.tags': 'list',
      n: 'number',
      ok: 'boolean',
      none: 'null',
      empty: 'empty',
      list: 'empty',
    });
  });

  it('round-trips every path through parsePath and valueAt, including a root array', () => {
    for (const root of [payload, [{ name: 'a' }, { name: 'b' }]]) {
      for (const leaf of flatten(root).leaves) {
        const read = valueAt(root, leaf.path);
        expect(read.present, leaf.path).toBe(true);
        expect(read.value, leaf.path).toBe(leaf.value);
      }
    }
    expect(flatten([{ name: 'a' }]).leaves.map((l) => l.path)).toEqual(['[0].name']);
  });

  it('tells a missing path from a field sent as null or empty', () => {
    expect(valueAt({ a: {} }, 'a.b')).toEqual({ value: '', type: 'null', present: false });
    expect(valueAt({ a: [1] }, 'a[3]')).toMatchObject({ present: false });
    expect(valueAt({ a: null }, 'a')).toEqual({ value: '', type: 'null', present: true });
    expect(valueAt({ a: '' }, 'a')).toEqual({ value: '', type: 'string', present: true });
    expect(valueAt('scalar', 'a')).toMatchObject({ present: false });
  });

  it('caps the number of leaves and says so', () => {
    const big = Object.fromEntries(Array.from({ length: MAX_LEAVES + 100 }, (_, i) => [`k${i}`, i]));
    const r = flatten(big);
    expect(r.leaves).toHaveLength(MAX_LEAVES);
    expect(r.truncated).toBe(true);
  });

  it('keeps nesting past the depth limit as one JSON leaf', () => {
    let v: unknown = { leaf: 1 };
    for (let i = 0; i < 15; i++) v = { [`l${i}`]: v };
    const { leaves } = flatten(v);
    expect(leaves).toHaveLength(1);
    expect(leaves[0].type).toBe('object');
    expect(leaves[0].path.split('.')).toHaveLength(11);
    expect(JSON.parse(leaves[0].value)).toHaveProperty('l3');
  });

  it('clamps long values', () => {
    const { leaves } = flatten({ long: 'x'.repeat(MAX_VALUE_CHARS + 500) });
    expect(leaves[0].value).toHaveLength(MAX_VALUE_CHARS);
  });

  it('quotes keys that are not plain identifiers', () => {
    expect(segment('ok_1')).toBe('ok_1');
    expect(segment('first-name')).toBe('first-name');
    expect(segment('first name')).toBe('["first name"]');
    expect(segment('1st')).toBe('["1st"]');
    expect(segment(2)).toBe('[2]');
    expect(parsePath('["first name"].x[2]')).toEqual(['first name', 'x', 2]);
    expect(valueAt({ 'a.b': { c: 1 } }, '["a.b"].c')).toMatchObject({ value: '1', present: true });
  });

  it('rejects paths the grammar cannot read', () => {
    for (const bad of ['', 'a..b', 'a.', 'a[x]', 'a[', 'my key', '["unterminated]', 'a[1', '.a', 'a.[0]', 'a[0]b']) {
      expect(() => parsePath(bad), bad).toThrow();
    }
  });
});
