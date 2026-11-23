import type { Jurisdiction } from './lead-timezone';
import type { QuietHours } from './quiet-hours';

/**
 * Legal calling hours, by jurisdiction, in the called party's local time.
 *
 * These are the law's floor, not a setting: an organization's quiet hours sit on
 * top and cannot switch them off. They apply to EVERY automated outbound contact
 * (AI calls, sequence texts, and the callbacks and texts a lead asked for) even
 * where a statute exempts calls made at the consumer's request: deliberately
 * stricter than the law, so a wrong exemption can never be the reason a call
 * went out at night.
 *
 * Each rule records where it came from and how it was checked. `statute_text`
 * means the statute itself was read on `reviewedAt`; `secondary_source` means
 * only compliance summaries were, the stricter reading was taken where they
 * disagreed, and legal review is still owed. Checking hours is one part of
 * compliance: consent, do-not-call lists, registration and per-day call caps
 * (Florida and Oklahoma) are not handled here.
 *
 * Not modelled yet: statutory-holiday bans (Ontario, Nova Scotia, Alberta,
 * British Columbia), per-day call caps, provincial deference under the CRTC rules.
 */
export const LEGAL_RULES_VERSION = '2026-11-02';

export interface LegalRule {
  /** 'US', 'CA', or 'US-FL' style. */
  jurisdiction: string;
  /** 0 = Sunday … 6 = Saturday, in the lead's zone. */
  days: readonly number[];
  /** When calls may be placed, HH:MM local; null = no calls on these days. */
  window: { start: string; end: string } | null;
  scope: 'telephone_solicitation';
  source: string;
  reviewedAt: string;
  verification: 'statute_text' | 'secondary_source';
  notes?: string;
}

const ALL = [0, 1, 2, 3, 4, 5, 6] as const;
const MON_FRI = [1, 2, 3, 4, 5] as const;
const MON_SAT = [1, 2, 3, 4, 5, 6] as const;
const SAT_SUN = [0, 6] as const;
const SAT = [6] as const;
const SUN = [0] as const;
const SCOPE = 'telephone_solicitation' as const;
const REVIEWED = '2026-11-02';

const daily = (jurisdiction: string, start: string, end: string, source: string, verification: LegalRule['verification'], notes?: string): LegalRule => ({
  jurisdiction,
  days: ALL,
  window: { start, end },
  scope: SCOPE,
  source,
  reviewedAt: REVIEWED,
  verification,
  ...(notes ? { notes } : {}),
});

export const LEGAL_RULES: readonly LegalRule[] = [
  // Federal
  daily('US', '08:00', '21:00', '47 CFR §64.1200(c)(1)', 'secondary_source', 'Local time at the called party\'s location. eCFR could not be fetched on the review date; the text is widely quoted.'),
  // Canada (CRTC Unsolicited Telecommunications Rules, Part III)
  { jurisdiction: 'CA', days: MON_FRI, window: { start: '09:00', end: '21:30' }, scope: SCOPE, source: 'CRTC Unsolicited Telecommunications Rules, Part III (Telecom Decision CRTC 2007-48)', reviewedAt: REVIEWED, verification: 'secondary_source', notes: 'Local time of the consumer. Provincial holiday bans not modelled.' },
  { jurisdiction: 'CA', days: SAT_SUN, window: { start: '10:00', end: '18:00' }, scope: SCOPE, source: 'CRTC Unsolicited Telecommunications Rules, Part III (Telecom Decision CRTC 2007-48)', reviewedAt: REVIEWED, verification: 'secondary_source' },
  // States read from the statute text
  daily('US-FL', '08:00', '20:00', 'Fla. Stat. §501.616(6)(a)', 'statute_text', 'Local time in the called person\'s time zone. (6)(b) also caps calls at three per 24 hours on the same subject; not enforced here.'),
  daily('US-WA', '08:00', '20:00', 'RCW 80.36.390(8)', 'statute_text', 'Call recipient\'s local time. (1)(b) exempts calls answering the called party\'s request; the exemption is not used.'),
  { jurisdiction: 'US-TX', days: MON_SAT, window: { start: '09:00', end: '21:00' }, scope: SCOPE, source: 'Tex. Bus. & Com. Code §301.051(b)(2)', reviewedAt: REVIEWED, verification: 'statute_text', notes: '(a) exempts calls at the consumer\'s express request and existing relationships; not used. The text names no time zone; applied in the lead\'s.' },
  { jurisdiction: 'US-TX', days: SUN, window: { start: '12:00', end: '21:00' }, scope: SCOPE, source: 'Tex. Bus. & Com. Code §301.051(b)(2)', reviewedAt: REVIEWED, verification: 'statute_text' },
  // States from compliance summaries only (stricter reading where they disagree) — legal review owed
  daily('US-OK', '08:00', '20:00', '15 O.S. §775C.3', 'secondary_source', 'Also caps calls at three per 24 hours on the same subject; not enforced here.'),
  daily('US-MA', '08:00', '20:00', 'M.G.L. c.159C §3', 'secondary_source'),
  { jurisdiction: 'US-RI', days: MON_FRI, window: { start: '09:00', end: '18:00' }, scope: SCOPE, source: 'R.I. Gen. Laws §5-61.1-5', reviewedAt: REVIEWED, verification: 'secondary_source', notes: 'Summaries disagree (one says 09:00–21:00); the stricter one is used.' },
  { jurisdiction: 'US-RI', days: SAT, window: { start: '10:00', end: '17:00' }, scope: SCOPE, source: 'R.I. Gen. Laws §5-61.1-5', reviewedAt: REVIEWED, verification: 'secondary_source' },
  { jurisdiction: 'US-RI', days: SUN, window: null, scope: SCOPE, source: 'R.I. Gen. Laws §5-61.1-5', reviewedAt: REVIEWED, verification: 'secondary_source' },
  daily('US-NV', '09:00', '20:00', 'NRS 228.660', 'secondary_source', 'Summaries disagree (09:00–20:00 vs 09:00–21:00); the stricter one is used.'),
  daily('US-KY', '10:00', '21:00', 'KRS 367.46955', 'secondary_source'),
  { jurisdiction: 'US-MN', days: MON_SAT, window: { start: '09:00', end: '21:00' }, scope: SCOPE, source: 'Minn. Stat. §325E.311', reviewedAt: REVIEWED, verification: 'secondary_source', notes: 'One summary lists Sundays and holidays as prohibited; Sundays are closed here, holidays are not modelled.' },
  { jurisdiction: 'US-MN', days: SUN, window: null, scope: SCOPE, source: 'Minn. Stat. §325E.311', reviewedAt: REVIEWED, verification: 'secondary_source' },
  daily('US-CO', '09:00', '21:00', 'C.R.S. §6-1-302', 'secondary_source'),
  daily('US-CT', '09:00', '21:00', 'C.G.S. §42-288a', 'secondary_source'),
  daily('US-IA', '09:00', '21:00', 'Iowa Code §476.16A', 'secondary_source'),
  daily('US-NH', '09:00', '21:00', 'N.H. Rev. Stat. §359-E:3', 'secondary_source'),
  daily('US-NJ', '09:00', '21:00', 'N.J.S.A. 56:8-130', 'secondary_source'),
  daily('US-NM', '09:00', '21:00', 'N.M. Stat. §57-12-22', 'secondary_source'),
  daily('US-ND', '09:00', '21:00', 'N.D. Cent. Code §51-28-02', 'secondary_source'),
  daily('US-OH', '09:00', '21:00', 'Ohio Rev. Code §4719.04', 'secondary_source'),
  daily('US-VT', '09:00', '21:00', '9 V.S.A. §2464', 'secondary_source'),
  daily('US-AK', '09:00', '21:00', 'Alaska Stat. §45.50.475', 'secondary_source'),
  daily('US-MI', '09:00', '21:00', 'MCL 445.111a', 'secondary_source'),
];

export interface LegalWindows {
  /** The rule that forbids calls on this day, or null. */
  closedBy: string | null;
  /** Each applicable rule as a quiet window (the hours OUTSIDE its allowed window). */
  quiet: { hours: QuietHours; rule: string }[];
}

const NORTH_AMERICA = /^(America\/|Pacific\/Honolulu|Atlantic\/Bermuda|US\/|Canada\/)/;

/**
 * The jurisdiction codes whose rules apply. A trusted estimate uses the phone
 * number's own country and state; a disputed or unknown one NEVER drops those
 * rules, it adds to them: the phone's codes plus both North American sets, so
 * a lead whose stored zone disagrees with their number is only ever held to
 * MORE hours, never fewer. The number decides whether North America applies;
 * the zone only speaks when the number says nothing.
 */
function codesFor(j: Jurisdiction, zone: string): string[] {
  const fromPhone = j.country ? [j.country, ...(j.region ? [`${j.country}-${j.region}`] : [])] : [];
  if (j.status === 'estimated') return fromPhone;
  const northAmerican = j.country ? j.country === 'US' || j.country === 'CA' : NORTH_AMERICA.test(zone);
  return [...new Set([...fromPhone, ...(northAmerican ? ['US', 'CA'] : [])])];
}

/** The legal quiet windows for one local day of `zone` (`weekday` 0 = Sunday). */
export function legalWindows(j: Jurisdiction, zone: string, weekday: number): LegalWindows {
  const codes = codesFor(j, zone);
  const out: LegalWindows = { closedBy: null, quiet: [] };
  for (const rule of LEGAL_RULES) {
    if (!codes.includes(rule.jurisdiction) || !rule.days.includes(weekday)) continue;
    if (!rule.window) return { closedBy: rule.jurisdiction, quiet: [] };
    out.quiet.push({ hours: { start: rule.window.end, end: rule.window.start }, rule: rule.jurisdiction });
  }
  return out;
}
