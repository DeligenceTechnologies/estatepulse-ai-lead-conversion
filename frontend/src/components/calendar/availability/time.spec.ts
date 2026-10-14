import { describe, expect, it } from 'vitest';
import { DAY_HOURS, hourLabel, placeIn, zoneCity } from './time';

describe('hourLabel', () => {
  it('reads the whole day, midnight to midnight', () => {
    expect(hourLabel(0)).toBe('12 AM');
    expect(hourLabel(13, true)).toBe('1:00 PM');
    expect(hourLabel(24)).toBe('12 AM');
    expect(DAY_HOURS).toEqual([0, 24]);
  });
});

describe('placeIn on the fixed day', () => {
  const day = { date: '2026-10-14', start: '2026-10-14T00:00:00.000Z', end: '2026-10-15T00:00:00.000Z' };

  it('places a range by its share of the whole day', () => {
    expect(placeIn({ start: '2026-10-14T06:00:00.000Z', end: '2026-10-14T18:00:00.000Z' }, day, DAY_HOURS)).toMatchObject({
      left: 25,
      width: 50,
    });
  });

  it('clips ranges that cross midnight and skips other days', () => {
    expect(placeIn({ start: '2026-10-13T22:00:00.000Z', end: '2026-10-14T03:00:00.000Z' }, day, DAY_HOURS)).toMatchObject({
      left: 0,
      width: 12.5,
    });
    expect(placeIn({ start: '2026-10-15T01:00:00.000Z', end: '2026-10-15T02:00:00.000Z' }, day, DAY_HOURS)).toBeNull();
  });
});

describe('zoneCity', () => {
  it('names the city part', () => {
    expect(zoneCity('America/Toronto')).toBe('Toronto');
    expect(zoneCity('Pacific/Pago_Pago')).toBe('Pago Pago');
  });
});
