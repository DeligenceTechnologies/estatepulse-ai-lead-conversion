/** The GSM 03.38 basic alphabet: one septet each. */
const GSM_BASIC = new Set(
  '@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&\'()*+,-./0123456789:;<=>?¡ABCDEFGHIJKLMNOPQRSTUVWXYZÄÖÑÜ§¿abcdefghijklmnopqrstuvwxyzäöñüà',
);
/** Its extension table: an escape plus the character, two septets. */
const GSM_EXTENDED = new Set('^{}\\[~]|€\f');

const GSM_SINGLE = 160;
const GSM_PART = 153;
const UCS2_SINGLE = 70;
const UCS2_PART = 67;

/**
 * How many SMS segments a carrier bills a text as. Text that fits the GSM
 * alphabet is 160 characters alone or 153 per part; anything else (an emoji, a
 * curly quote) makes the whole text UCS-2: 70 alone, 67 per part, counted in
 * UTF-16 units. An empty text still costs one segment.
 */
export function smsSegments(body: string): number {
  let septets = 0;
  let gsm = true;
  for (const ch of body) {
    if (GSM_BASIC.has(ch)) septets += 1;
    else if (GSM_EXTENDED.has(ch)) septets += 2;
    else {
      gsm = false;
      break;
    }
  }
  if (gsm) return septets <= GSM_SINGLE ? 1 : Math.ceil(septets / GSM_PART);
  return body.length <= UCS2_SINGLE ? 1 : Math.ceil(body.length / UCS2_PART);
}
