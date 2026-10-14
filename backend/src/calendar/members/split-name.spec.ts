import { describe, expect, it } from 'vitest';
import { splitName } from './calendar-members.service';

describe('splitName', () => {
  it('splits first name from the rest', () => {
    expect(splitName('  Ada  King Lovelace ', 'ada@x.io')).toEqual({ firstName: 'Ada', lastName: 'King Lovelace' });
  });

  it('falls back to the email local part when the name is empty or an email', () => {
    expect(splitName('', 'ada@x.io')).toEqual({ firstName: 'ada', lastName: '' });
    expect(splitName('ada@x.io', 'ada@x.io')).toEqual({ firstName: 'ada', lastName: '' });
  });

  it('caps each part at 100 characters', () => {
    const long = 'a'.repeat(150);
    const { firstName, lastName } = splitName(`${long} ${long}`, 'x@y.z');
    expect(firstName).toHaveLength(100);
    expect(lastName).toHaveLength(100);
  });
});
