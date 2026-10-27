import { describe, expect, it } from 'vitest';
import { dispositionOf } from './activity.service';

describe('dispositionOf', () => {
  it('tells a conversation from a pick-up-and-hang-up by talk time', () => {
    // The two answered calls from the live tests on 2026-10-26.
    expect(dispositionOf({ answered: true, durationSeconds: 157, hangupCause: 'normal_clearing' })).toBe('connected');
    expect(dispositionOf({ answered: true, durationSeconds: 2, hangupCause: 'normal_clearing' })).toBe('short');
  });

  it('reads an unanswered call from Telnyx hangup_cause', () => {
    expect(dispositionOf({ answered: false, durationSeconds: 21, hangupCause: 'unspecified' })).toBe('no_answer');
    expect(dispositionOf({ answered: false, durationSeconds: 30, hangupCause: 'timeout' })).toBe('no_answer');
    expect(dispositionOf({ answered: false, durationSeconds: 5, hangupCause: 'user_busy' })).toBe('busy');
    expect(dispositionOf({ answered: false, durationSeconds: 4, hangupCause: 'call_rejected' })).toBe('rejected');
  });

  it('a number that does not exist: not_found, or the SIP answer behind any cause', () => {
    expect(dispositionOf({ answered: false, durationSeconds: 1, hangupCause: 'not_found', sipCause: '404' })).toBe('invalid_number');
    for (const sip of ['404', '410', '484', '604']) {
      expect(dispositionOf({ answered: false, durationSeconds: 1, hangupCause: 'unspecified', sipCause: sip })).toBe('invalid_number');
    }
  });

  it('busy and declined from the SIP code too', () => {
    expect(dispositionOf({ answered: false, durationSeconds: 3, hangupCause: 'unspecified', sipCause: '486' })).toBe('busy');
    expect(dispositionOf({ answered: false, durationSeconds: 3, hangupCause: 'unspecified', sipCause: '603' })).toBe('rejected');
  });

  it('the network failing is a failed call, not the lead not answering', () => {
    expect(dispositionOf({ answered: false, durationSeconds: 2, hangupCause: 'unspecified', sipCause: '503' })).toBe('failed');
    expect(dispositionOf({ answered: false, durationSeconds: 40, hangupCause: 'timeout', sipCause: '487' })).toBe('no_answer');
  });

  it('names Telnyx never sends are not read as a dead number', () => {
    expect(dispositionOf({ answered: false, durationSeconds: 1, hangupCause: 'unallocated_number' })).toBe('no_answer');
  });

  it('an answering machine is a voicemail however long it ran, never a conversation', () => {
    expect(dispositionOf({ answered: true, machine: true, durationSeconds: 38, hangupCause: 'normal_clearing' })).toBe('voicemail');
    expect(dispositionOf({ answered: true, machine: true, durationSeconds: 4, hangupCause: 'normal_clearing' })).toBe('voicemail');
  });
});
