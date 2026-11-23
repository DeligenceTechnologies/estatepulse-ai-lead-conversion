import { BadRequestException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { assertMemberAreas, assertMemberPhone } from './member-contact';

describe('a team member’s contact details', () => {
  it('needs a phone with its country code', () => {
    for (const bad of [undefined, null, '', '   ', '98765 43210', '+12 34']) {
      expect(() => assertMemberPhone(bad)).toThrow(BadRequestException);
    }
    expect(() => assertMemberPhone('+91 98765 43210')).not.toThrow();
  });

  it('needs at least one area they cover', () => {
    for (const bad of [undefined, null, [], ['', '  '], [' , ']]) {
      expect(() => assertMemberAreas(bad)).toThrow(BadRequestException);
    }
    expect(() => assertMemberAreas(['78704'])).not.toThrow();
  });
});
