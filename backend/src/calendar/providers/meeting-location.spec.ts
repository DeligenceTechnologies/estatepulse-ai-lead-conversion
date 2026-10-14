import { describe, expect, it } from 'vitest';
import { hexColor, mapLimit, meetingPlace, webLink } from './meeting-location';

describe('meetingPlace', () => {
  it('takes the join link and keeps a readable location', () => {
    expect(meetingPlace(['https://zoom.us/j/1'], ['221B Baker St'])).toEqual({
      meetingUrl: 'https://zoom.us/j/1',
      location: '221B Baker St',
    });
  });

  it('uses a link written as the location when there is no join link', () => {
    expect(meetingPlace([null], ['https://meet.google.com/abc'])).toEqual({
      meetingUrl: 'https://meet.google.com/abc',
      location: null,
    });
  });

  it('drops provider codes and non-web links', () => {
    expect(meetingPlace([undefined], ['integrations:daily'])).toEqual({ meetingUrl: null, location: null });
    expect(webLink('javascript:alert(1)')).toBeNull();
    expect(webLink('  ')).toBeNull();
  });
});

describe('mapLimit', () => {
  it('keeps order and never runs more than the limit at once', async () => {
    let running = 0;
    let peak = 0;
    const result = await mapLimit([30, 10, 20, 5], 2, async (ms) => {
      running++;
      peak = Math.max(peak, running);
      await new Promise((resolve) => setTimeout(resolve, ms));
      running--;
      return ms * 2;
    });
    expect(result).toEqual([60, 20, 40, 10]);
    expect(peak).toBe(2);
  });
});

describe('hexColor', () => {
  it('keeps hex colours and rejects anything else', () => {
    expect(hexColor('#8247F5')).toBe('#8247f5');
    expect(hexColor('#fff')).toBe('#fff');
    expect(hexColor('red; background: url(x)')).toBeNull();
    expect(hexColor(null)).toBeNull();
  });
});
