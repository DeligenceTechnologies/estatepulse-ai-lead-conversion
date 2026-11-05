/**
 * What a lead receives from an outreach text, for the editors' preview. The
 * footer rules mirror backend/src/telnyx/sms/sms-compliance.ts: the first
 * text to a number gets the brand and "Reply STOP to opt out", and every text
 * to a Canadian number names the brokerage and our number (CASL).
 */

export const OPT_OUT_LINE = 'Reply STOP to opt out.';

export function hasOptOutLine(text: string): boolean {
  return /\b(reply|text|send|txt)\s+["']?stop\b/i.test(text) || /\bstop\b.{0,25}\b(opt[\s-]?out|unsubscribe|cancel)\b/i.test(text);
}

/** "+17427245092" → "(742) 724-5092"; any other number as it is. */
export function displayNumber(phone: string): string {
  const d = phone.replace(/\D/g, '');
  return d.length === 11 && d.startsWith('1') ? `(${d.slice(1, 4)}) ${d.slice(4, 7)}-${d.slice(7)}` : phone;
}

export function withOutreachFooter(input: { text: string; brokerage: string; ourNumber: string; canadian: boolean; firstText: boolean }): string {
  const { text, brokerage, ourNumber, canadian, firstText } = input;
  if (!canadian && !firstText) return text;
  const stop = hasOptOutLine(text) ? '' : OPT_OUT_LINE;
  if (canadian) return `${text}\n${brokerage}, ${displayNumber(ourNumber)}.${stop ? ` ${stop}` : ''}`;
  const named = text.toLowerCase().includes(brokerage.toLowerCase());
  if (named && !stop) return text;
  if (named) return `${text}\n${stop}`;
  return `${text}\n${brokerage}${stop ? `: ${stop}` : '.'}`;
}

/** Sample lead details for the preview; a placeholder without one is shown as written. */
const SAMPLE: Record<string, string> = { firstName: 'Ana', lastName: 'Lopez', location: 'Austin', timeline: '3 months' };

/** The template with the sample lead and the organization's name filled in, spaced as the server does. */
export function previewTemplate(template: string, brokerage: string): string {
  return template
    .replace(/\{\{\s*(\w+)\s*\}\}/g, (whole, key: string) => (key === 'brokerage' ? brokerage : (SAMPLE[key] ?? whole)))
    .replace(/[ \t]+/g, ' ')
    .replace(/[ \t]+([,.!?])/g, '$1')
    .trim();
}

const GSM7 = new Set(
  "@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !\"#¤%&'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà",
);
/** GSM-7 characters that take two places. */
const GSM7_EXTENDED = new Set('^{}\\[~]|€\f');

export interface SmsSize {
  /** UCS-2 when any character is outside GSM-7 (an emoji, a curly quote, an em dash): 70 characters a text instead of 160. */
  encoding: 'GSM-7' | 'UCS-2';
  segments: number;
  /** The character that forced UCS-2, to point at. */
  culprit: string | null;
}

/** How many SMS a text is billed as. */
export function smsSize(text: string): SmsSize {
  let units = 0;
  for (const ch of text) {
    if (GSM7.has(ch)) units += 1;
    else if (GSM7_EXTENDED.has(ch)) units += 2;
    else {
      const length = text.length;
      return { encoding: 'UCS-2', segments: length === 0 ? 0 : length <= 70 ? 1 : Math.ceil(length / 67), culprit: ch };
    }
  }
  return { encoding: 'GSM-7', segments: units === 0 ? 0 : units <= 160 ? 1 : Math.ceil(units / 153), culprit: null };
}
