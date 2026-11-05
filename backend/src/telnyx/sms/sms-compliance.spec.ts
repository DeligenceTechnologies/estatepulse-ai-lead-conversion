import { describe, expect, it } from 'vitest';
import { businessDetails, businessDetailsComplete, displayNumber, hasOptOutLine, isCanadian, withOutreachFooter } from './sms-compliance';

const base = { brokerage: 'Skyline Realty', ourNumber: '+17427245092' };
/** Characters in the GSM-7 basic set: a text made only of these is not sent as 70-character UCS-2. */
const GSM7 = /^[A-Za-z0-9 \n\r@£$¥èéùìòÇØøÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ!"#¤%&'()*+,\-./:;<=>?¡ÄÖÑÜ§¿äöñüà]*$/;

describe('withOutreachFooter', () => {
  it('adds the brand and the STOP line to a first text that has neither', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana, are you still looking?', canadian: false, firstText: true })).toBe(
      'Hi Ana, are you still looking?\nSkyline Realty: Reply STOP to opt out.',
    );
  });

  it('adds only the STOP line when the text names the brokerage, in any case', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana, this is SKYLINE REALTY.', canadian: false, firstText: true })).toBe(
      'Hi Ana, this is SKYLINE REALTY.\nReply STOP to opt out.',
    );
  });

  it('adds nothing to a first text that already has both', () => {
    const text = 'Hi Ana, Skyline Realty here. Reply STOP to unsubscribe.';
    expect(withOutreachFooter({ ...base, text, canadian: false, firstText: true })).toBe(text);
  });

  it('adds only the brand to a first text that already says how to stop', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana! Text STOP to opt out.', canadian: false, firstText: true })).toBe(
      'Hi Ana! Text STOP to opt out.\nSkyline Realty.',
    );
  });

  it('leaves a later text to a US number alone', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana', canadian: false, firstText: false })).toBe('Hi Ana');
  });

  it('names the brokerage and our number on every Canadian text, without repeating a STOP line', () => {
    expect(withOutreachFooter({ ...base, text: 'Hi Ana', canadian: true, firstText: false })).toBe('Hi Ana\nSkyline Realty, (742) 724-5092. Reply STOP to opt out.');
    expect(withOutreachFooter({ ...base, text: 'Hi Ana. Reply STOP to opt out', canadian: true, firstText: false })).toBe(
      'Hi Ana. Reply STOP to opt out\nSkyline Realty, (742) 724-5092.',
    );
  });

  it('never adds a character that would switch a text to UCS-2', () => {
    for (const canadian of [true, false]) {
      const sent = withOutreachFooter({ ...base, text: 'Hi Ana', canadian, firstText: true });
      expect(sent).toMatch(GSM7);
    }
  });
});

describe('hasOptOutLine', () => {
  it.each(['Reply STOP to opt out', 'reply stop to unsubscribe', 'Text "STOP" to end', 'STOP to opt-out', 'Txt STOP to cancel'])('finds "%s"', (text) => {
    expect(hasOptOutLine(text)).toBe(true);
  });

  it.each(['Hi Ana', "I'll stop by the open house", 'Quick question about your search'])('finds nothing in "%s"', (text) => {
    expect(hasOptOutLine(text)).toBe(false);
  });
});

describe('numbers', () => {
  it('tells a Canadian number from a US one', () => {
    expect(isCanadian('+12899174129')).toBe(true);
    expect(isCanadian('+14165550123')).toBe(true);
    expect(isCanadian('+15125550188')).toBe(false);
    expect(isCanadian('+918447329358')).toBe(false);
  });

  it('writes our number as people do', () => {
    expect(displayNumber('+17427245092')).toBe('(742) 724-5092');
    expect(displayNumber('+918447329358')).toBe('+91 84473 29358');
  });
});

describe('businessDetails', () => {
  it('reads the stored setting, trimmed, with anything missing empty', () => {
    expect(businessDetails({ mailingAddress: '  100 King St W  ', email: 7 })).toEqual({ legalName: '', mailingAddress: '100 King St W', email: '', website: '' });
    expect(businessDetails(null)).toEqual({ legalName: '', mailingAddress: '', email: '', website: '' });
  });

  it('is complete once the mailing address is there', () => {
    expect(businessDetailsComplete(businessDetails({ mailingAddress: '100 King St W' }))).toBe(true);
    expect(businessDetailsComplete(businessDetails({ website: 'skyline.ca' }))).toBe(false);
  });
});
