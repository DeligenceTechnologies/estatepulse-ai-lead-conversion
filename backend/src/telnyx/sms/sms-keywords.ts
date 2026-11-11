import { displayNumber, type BusinessDetails } from './sms-compliance';

/**
 * Texting-program keywords in a lead's text, read before anyone treats it as
 * a conversation: an opt-out, an opt-in or a request for help. The FCC counts
 * any reasonable way of saying stop, carriers want STOP and HELP answered
 * (CTIA), and Canada adds ARRET and AIDE (CWTA). The clear cases are matched
 * here without AI; the intent check reads everything else.
 */

export type SmsKeyword = 'opt_out' | 'opt_in' | 'help';

export interface KeywordMatch {
  kind: SmsKeyword;
  /** Said in French (ARRÊT, AIDE): the answer goes back in French. */
  french: boolean;
  /** An opt-out Telnyx matched itself: it blocked the number on the messaging profile and sent the confirmation. */
  byTelnyx: boolean;
}

/** Telnyx's own opt-out words, as the whole text. */
const TELNYX_STOP = new Set(['stop', 'stopall', 'stop all', 'unsubscribe', 'cancel', 'end', 'quit']);
/** Words that are an opt-out on their own: Telnyx's, the rest of the FCC's seven, and the French ARRÊT. */
const OPT_OUT = new Set([...TELNYX_STOP, 'revoke', 'opt out', 'optout', 'arret', 'arrete', 'arretez']);
/** The words Telnyx lifts its block on; anything else, "yes" included, is an ordinary reply. */
const OPT_IN = new Set(['start', 'unstop']);
const HELP = new Set(['help', 'info', 'aide']);

/** Opening or closing a short text, these make it a stop: "stop please", "please stop", "STOP!!". */
const STOP_ENDS = new Set(['stop', 'unsubscribe', 'arret', 'arrete', 'arretez']);
const SHORT_WORDS = 4;
const NEGATIONS = new Set(['dont', 'not', 'never', 'didnt', 'doesnt', 'cant', 'wont']);
/** "Stop by the open house": a visit, not an opt-out. */
const STOP_BY = new Set(['by', 'in', 'over']);

/** An opt-out in so many words, wherever it is in the text. */
const PHRASES: RegExp[] = [
  /\b(stop|quit|cease) (texting|txting|messaging|contacting|sending|spamming|bothering|harassing)\b/,
  /\bunsubscribe\b/,
  /\bopt (me )?out\b/,
  /\bremove (me|my (number|phone|info|details|name))\b/,
  /\btake (me|my (number|name|info|details)) off\b/,
  /\b(delete|lose) my (number|phone number|info|details)\b/,
  /\bleave me alone\b/,
  // At the end only: "don't text me after 9" is a request about when, not an opt-out.
  /\b(dont|do not|never) (ever )?(text|txt|message|contact) (me|us|this number)( again| anymore| ever again)?$/,
  /\barrete[rz]? de m(e )?(ecrire|texter|envoyer|contacter|appeler)\b/,
  /\b(desabonn|desinscri)/,
];
const FRENCH = /\b(arret|arrete[rz]?|desabonn\w*|desinscri\w*)\b/;

/** Lower case, accents and punctuation gone: "ARRÊT!" → "arret", "Opt-out." → "opt out". */
export function plainText(text: string): string {
  return text
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function isOptOut(said: string, raw: string): boolean {
  if (OPT_OUT.has(said)) return true;
  const words = said.split(' ');
  const short =
    words.length <= SHORT_WORDS &&
    !raw.includes('?') &&
    (STOP_ENDS.has(words[0]) || STOP_ENDS.has(words[words.length - 1])) &&
    !words.some((w) => NEGATIONS.has(w)) &&
    !(words[0] === 'stop' && STOP_BY.has(words[1]));
  return short || PHRASES.some((p) => p.test(said));
}

/** Whether an opt-out was said in French, so its confirmation goes back in French. */
export const saidInFrench = (text: string): boolean => FRENCH.test(plainText(text));

/** The one text allowed after an opt-out: no marketing, just that it worked and how to undo it. */
export function optOutConfirmation(brokerage: string, french: boolean): string {
  return french
    ? `Vous êtes désabonné(e) des messages de ${brokerage}. Répondez START pour vous réabonner.`
    : `You're unsubscribed from ${brokerage} and won't get more messages from us. Reply START to resubscribe.`;
}

/**
 * The answer to HELP, AIDE or INFO: who is texting, how to reach a person,
 * and how to stop, with the mailing address, email and website the
 * organization gave (CASL wants the address within reach of a Canadian lead).
 */
export function helpReply(brokerage: string, ourNumber: string, french: boolean, details?: BusinessDetails): string {
  const d = details ?? { legalName: '', mailingAddress: '', email: '', website: '' };
  const who = d.legalName && d.legalName.toLowerCase() !== brokerage.toLowerCase() ? `${brokerage} (${d.legalName})` : brokerage;
  const online = d.email || d.website;
  const number = displayNumber(ourNumber);
  if (french) {
    const reach = online ? `${number} ou ${online}` : number;
    const mail = d.mailingAddress ? ` Adresse : ${d.mailingAddress}.` : '';
    return `${who} : messages sur votre recherche immobilière. Fréquence variable; des frais de messagerie peuvent s'appliquer. Aide : ${reach}.${mail} Répondez ARRET pour vous désabonner.`;
  }
  const reach = online ? `${number} or ${online}` : number;
  const mail = d.mailingAddress ? ` Mail: ${d.mailingAddress}.` : '';
  return `${who}: texts about your home search. Msg frequency varies; msg & data rates may apply. For help, call or text ${reach}.${mail} Reply STOP to opt out.`;
}

/**
 * What a text asks of the texting program, or null for an ordinary reply.
 * `telnyxType` is the webhook's `autoresponse_type`: Telnyx's own verdict on
 * the keyword, trusted over the text.
 */
export function smsKeyword(text: string, telnyxType?: unknown): KeywordMatch | null {
  const said = plainText(text);
  const type = typeof telnyxType === 'string' ? telnyxType.toUpperCase() : '';
  if (type === 'STOP' || TELNYX_STOP.has(said)) return { kind: 'opt_out', french: false, byTelnyx: true };
  if (isOptOut(said, text)) return { kind: 'opt_out', french: FRENCH.test(said), byTelnyx: false };
  if (type === 'START' || OPT_IN.has(said)) return { kind: 'opt_in', french: false, byTelnyx: false };
  if (type === 'HELP' || HELP.has(said)) return { kind: 'help', french: said === 'aide', byTelnyx: false };
  return null;
}
