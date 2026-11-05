import { describe, expect, test } from 'vitest';
import { crmNoNameReason } from '@/crm/crm-records';
import { PHONE_UNPARSED_REASON } from '@/google-sheets/sheet-rows';
import { PHONE_NO_CODE_REASON, PHONE_UNREADABLE_REASON, liveReviewReasons } from './review-reasons';

const HUBSPOT = { displayName: 'HubSpot' } as Parameters<typeof crmNoNameReason>[0];
const DNC = 'This contact previously opted out — imported as do-not-contact';

const lead = (over: Partial<Parameters<typeof liveReviewReasons>[0]> = {}) => ({
  firstName: null,
  lastName: null,
  phone: '9024848980',
  phoneValid: false,
  reviewReasons: [PHONE_UNPARSED_REASON],
  ...over,
});

describe('warnings a lead has outgrown', () => {
  test('the phone warning goes once the number can be dialled', () => {
    expect(liveReviewReasons(lead({ phone: '+919024848980', phoneValid: true }))).toEqual([]);
  });

  test('and once the number is gone altogether', () => {
    expect(liveReviewReasons(lead({ phone: null }))).toEqual([]);
  });

  test('but stays while the number still cannot be dialled', () => {
    expect(liveReviewReasons(lead())).toEqual([PHONE_NO_CODE_REASON]);
  });

  test('three checks complaining about one number become one short line', () => {
    const reasons = [
      'Phone: "9024848980" has no country code, so we cannot tell which country it is from — add one, e.g. +91 98765 43210',
      PHONE_UNPARSED_REASON,
    ];
    expect(liveReviewReasons(lead({ reviewReasons: [DNC, ...reasons] }))).toEqual([DNC, PHONE_NO_CODE_REASON]);
  });

  test('a number with a code that still cannot be read says so instead', () => {
    const reasons = ['Phone: "+91 123" is not a phone number we can read', PHONE_UNPARSED_REASON];
    expect(liveReviewReasons(lead({ phone: '+91 123', reviewReasons: reasons }))).toEqual([PHONE_UNREADABLE_REASON]);
  });

  test('the no-name warning goes once a name arrives', () => {
    const reasons = [crmNoNameReason(HUBSPOT)];
    expect(liveReviewReasons(lead({ firstName: 'Manish', reviewReasons: reasons }))).toEqual([]);
    expect(liveReviewReasons(lead({ reviewReasons: reasons }))).toEqual(reasons);
  });

  test('a do-not-contact note is never dropped, and neither is anything unrecognised', () => {
    const reasons = [DNC, 'Imported from HubSpot — awaiting owner approval'];
    expect(liveReviewReasons(lead({ phoneValid: true, reviewReasons: reasons }))).toEqual(reasons);
  });
});
