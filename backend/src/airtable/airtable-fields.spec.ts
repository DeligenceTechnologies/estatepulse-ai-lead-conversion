import { describe, expect, it } from 'vitest';
import { CREATABLE_TYPES, isCreatable, newFieldBody, sameFieldName } from './airtable-fields';

/**
 * Creating an Airtable column. Airtable rejects several field types outright
 * unless their required `options` are present, so what is pinned here is that
 * every creatable type is sent complete.
 */

describe('which field types may be created', () => {
  it('offers the writable types and none that Airtable computes', () => {
    for (const t of ['singleLineText', 'email', 'currency', 'date', 'checkbox', 'singleSelect']) expect(isCreatable(t)).toBe(true);
    // Airtable computes these; creating one from a lead field would be meaningless.
    for (const t of ['formula', 'rollup', 'count', 'autoNumber', 'lastModifiedTime', 'multipleAttachments', 'button']) {
      expect(isCreatable(t)).toBe(false);
    }
  });
});

describe('the body sent to Airtable', () => {
  it('sends no options for the types that take none', () => {
    for (const type of ['singleLineText', 'multilineText', 'email', 'url', 'phoneNumber'] as const) {
      expect(newFieldBody({ name: 'X', type })).toEqual({ name: 'X', type });
    }
  });

  it.each([
    ['number', { precision: 0 }],
    ['percent', { precision: 0 }],
  ])('sends the precision %s requires', (type, options) => {
    expect(newFieldBody({ name: 'X', type: type as never }).options).toEqual(options);
  });

  it('sends a currency symbol, which Airtable requires and does not default', () => {
    expect(newFieldBody({ name: 'Budget', type: 'currency' }).options).toEqual({ precision: 2, symbol: '$' });
    expect(newFieldBody({ name: 'Budget', type: 'currency', currencySymbol: '£' }).options).toEqual({ precision: 2, symbol: '£' });
  });

  it('sends the date and time options Airtable marks required', () => {
    expect(newFieldBody({ name: 'When', type: 'date' }).options).toEqual({ dateFormat: { name: 'iso' } });
    expect(newFieldBody({ name: 'When', type: 'dateTime' }).options).toEqual({
      timeZone: 'utc',
      dateFormat: { name: 'iso' },
      timeFormat: { name: '24hour' },
    });
  });

  it('sends both keys a checkbox requires', () => {
    expect(newFieldBody({ name: 'Done', type: 'checkbox' }).options).toEqual({ color: 'greenBright', icon: 'check' });
  });

  it('sends a select’s choices, dropping empty ones', () => {
    expect(newFieldBody({ name: 'Stage', type: 'singleSelect', choices: ['New', ' ', 'Won'] }).options).toEqual({
      choices: [{ name: 'New' }, { name: 'Won' }],
    });
    expect(newFieldBody({ name: 'Tags', type: 'multipleSelects' }).options).toEqual({ choices: [] });
  });

  it('trims the name, so a stray space does not become part of the column', () => {
    expect(newFieldBody({ name: '  Budget  ', type: 'singleLineText' }).name).toBe('Budget');
  });

  it('every creatable type produces a body Airtable will take', () => {
    for (const type of CREATABLE_TYPES) {
      const body = newFieldBody({ name: 'X', type });
      expect(body.name).toBe('X');
      expect(body.type).toBe(type);
    }
  });
});

describe('not creating a column twice', () => {
  it('reads two names the way a person would, so a near-match is still the same column', () => {
    expect(sameFieldName('Budget', 'budget')).toBe(true);
    expect(sameFieldName(' Budget ', 'Budget')).toBe(true);
    expect(sameFieldName('Budget', 'Max budget')).toBe(false);
  });
});
