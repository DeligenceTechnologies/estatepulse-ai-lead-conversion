import type { Prisma } from '@prisma/client';
import type { PrismaService } from '@/common/prisma/prisma.service';
import { normalizeEmail, normalizePhone } from '@/lead/duplicates/identity';

/**
 * Finding the one lead the user means. A phone number or email is matched exactly. A name is ranked by
 * how well each word fits, so "Rahul" finds Rahul Sharma, "Rahul S" picks him over Rahul Verma, and
 * "Shrma" still finds Sharma.
 *
 * Ranking runs here rather than in the database because our Postgres server has no pg_trgm. The
 * trigram measure below is pg_trgm's, so if the extension is installed later, only the candidate
 * query moves onto a trigram index; the scores and the decision stay as they are.
 */

/** "one": act on it. "ambiguous": ask the user which one, or whether it is the one. "none": nothing fits. */
export type MatchKind = 'one' | 'ambiguous' | 'none';

/** A clear match scores at least this, and at least GAP more than the next one. */
export const CLEAR = 0.85;
export const GAP = 0.15;
/** Below this a lead is not offered as the one meant. */
export const PLAUSIBLE = 0.5;
/** When asking which one, only leads this close to the best are offered: four exact "Sunny Patel"s hide a "Sunny Shah". */
export const NEAR = 0.25;
/** Below this a lead is not even offered as "closest". */
export const SUGGEST = 0.3;
/** A query word the name word starts with, like "Sh" for Sharma: nearly as good as the whole word. */
const PREFIX = 0.9;
const NAME_WEIGHT = 0.9;
/** Breaks ties between two people of the same name in favour of the one being worked now. */
const RECENT_WEIGHT = 0.1;
const RECENT_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_QUERY_WORDS = 4;
const MAX_CLOSEST = 3;
/** Leads scored per search. An office with more leads sharing a letter loses its oldest untouched ones. */
export const MAX_CANDIDATES = 3000;
const MAX_EXACT = 25;

/** Lower case, accents dropped, punctuation turned into spaces. */
export function normalizeText(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const wordsOf = (s: string): string[] => normalizeText(s).split(' ').filter(Boolean);

/** pg_trgm's trigrams of one word: padded with two spaces in front and one behind. */
function trigrams(word: string): Set<string> {
  const padded = `  ${word} `;
  const out = new Set<string>();
  for (let i = 0; i + 3 <= padded.length; i++) out.add(padded.slice(i, i + 3));
  return out;
}

/** pg_trgm's similarity() of two words: shared trigrams over distinct trigrams. */
export function trigramSimilarity(a: string, b: string): number {
  if (!a || !b) return 0;
  const ta = trigrams(a);
  const tb = trigrams(b);
  let shared = 0;
  for (const t of ta) if (tb.has(t)) shared++;
  return shared / (ta.size + tb.size - shared);
}

/** Edits apart (insert, delete, change, swap two neighbours), so typos like "Jhon" still score. */
function editDistance(a: string, b: string): number {
  const d: number[][] = Array.from({ length: a.length + 1 }, (_, i) => [i, ...Array<number>(b.length).fill(0)]);
  for (let j = 1; j <= b.length; j++) d[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
    }
  }
  return d[a.length][b.length];
}

/** How well one typed word fits one word of a name, from 0 to 1. */
export function wordScore(typed: string, word: string): number {
  if (typed === word) return 1;
  if (word.startsWith(typed)) return PREFIX;
  const trigram = trigramSimilarity(typed, word);
  // Too short for a typo to mean anything: "Al" is one change from "Ed".
  if (typed.length < 3 || word.length < 3) return trigram;
  return Math.max(trigram, 1 - editDistance(typed, word) / Math.max(typed.length, word.length));
}

/** Each typed word takes its best word of the name (each name word used once); the result is their average. */
export function nameScore(typed: string[], firstName: string | null, lastName: string | null): number {
  const name = wordsOf(`${firstName ?? ''} ${lastName ?? ''}`);
  if (typed.length === 0 || name.length === 0) return 0;
  const used = new Set<number>();
  let total = 0;
  for (const t of typed) {
    let best = 0;
    let at = -1;
    name.forEach((w, i) => {
      if (used.has(i)) return;
      const s = wordScore(t, w);
      if (s > best) [best, at] = [s, i];
    });
    if (at >= 0) used.add(at);
    total += best;
  }
  return total / typed.length;
}

export interface Candidate {
  id: string;
  firstName: string | null;
  lastName: string | null;
  lastContactAt: Date | null;
  createdAt: Date;
}

export interface Ranked {
  id: string;
  score: number;
}

/** Best first. Equal scores keep the order the candidates came in. */
export function rankByName(query: string, candidates: readonly Candidate[], now: Date): Ranked[] {
  const typed = wordsOf(query).slice(0, MAX_QUERY_WORDS);
  const recentSince = now.getTime() - RECENT_MS;
  return candidates
    .map((c) => {
      const recent = (c.lastContactAt ?? c.createdAt).getTime() >= recentSince;
      return { id: c.id, score: NAME_WEIGHT * nameScore(typed, c.firstName, c.lastName) + (recent ? RECENT_WEIGHT : 0) };
    })
    .sort((a, b) => b.score - a.score);
}

export interface SearchOutcome {
  match: MatchKind;
  /** The lead meant ("one"), or the leads it could be ("ambiguous"), best first. */
  ids: string[];
  /** How many leads could be meant, which can be more than `ids` holds. */
  total: number;
  /** When nothing fits, the nearest names, so the user can spot a typo. */
  closest: string[];
}

export function decide(ranked: readonly Ranked[], limit: number): SearchOutcome {
  const plausible = ranked.filter((r) => r.score >= PLAUSIBLE);
  if (plausible.length === 0) {
    return { match: 'none', ids: [], total: 0, closest: ranked.filter((r) => r.score >= SUGGEST).slice(0, MAX_CLOSEST).map((r) => r.id) };
  }
  const [top, next] = plausible;
  if (top.score >= CLEAR && (!next || top.score - next.score >= GAP)) {
    return { match: 'one', ids: [top.id], total: 1, closest: [] };
  }
  const near = plausible.filter((r) => r.score >= top.score - NEAR);
  return { match: 'ambiguous', ids: near.slice(0, limit).map((r) => r.id), total: near.length, closest: [] };
}

/** Exact look-ups decide by count: one lead, several sharing the number, or none. */
const byCount = (ids: string[], limit: number): SearchOutcome => ({
  match: ids.length === 0 ? 'none' : ids.length === 1 ? 'one' : 'ambiguous',
  ids: ids.slice(0, limit),
  total: ids.length,
  closest: [],
});

/** Digits only and enough of them to be a phone number or its last few digits. */
const PHONE_LIKE = /^[\d\s()+.-]+$/;
const MIN_PHONE_DIGITS = 4;

/**
 * Searches inside `where`, which already holds the user's visibility and the filters.
 * A phone number matches the stored E.164 number, or its ending when typed without the country code.
 */
export async function findLeads(prisma: PrismaService, where: Prisma.LeadWhereInput, query: string, limit: number, now = new Date()): Promise<SearchOutcome> {
  const q = query.trim();
  const ids = async (match: Prisma.LeadWhereInput) =>
    (await prisma.lead.findMany({ where: { AND: [where, match] }, select: { id: true }, orderBy: { createdAt: 'desc' }, take: MAX_EXACT })).map((r) => r.id);

  if (q.includes('@')) {
    const email = normalizeEmail(q);
    return byCount(await ids(email ? { normalizedEmail: email } : { email: { contains: q, mode: 'insensitive' } }), limit);
  }

  const digits = q.replace(/\D/g, '');
  if (PHONE_LIKE.test(q) && digits.length >= MIN_PHONE_DIGITS) {
    const e164 = normalizePhone(q) ?? (digits.length >= 10 ? normalizePhone(`+${digits}`) : null);
    // A national number typed with its trunk zero ("07911 123456") still ends the stored "+447911123456".
    const ending = digits.replace(/^0+/, '');
    const match: Prisma.LeadWhereInput[] = [
      ...(e164 ? [{ normalizedPhone: e164 }] : []),
      ...(ending.length >= MIN_PHONE_DIGITS ? [{ normalizedPhone: { endsWith: ending } }] : []),
    ];
    return byCount(match.length > 0 ? await ids({ OR: match }) : [], limit);
  }

  const typed = wordsOf(q).slice(0, MAX_QUERY_WORDS);
  if (typed.length === 0) return byCount([], limit);
  const candidates = await prisma.lead.findMany({
    where: { AND: [where, namePrefilter(typed)] },
    select: { id: true, firstName: true, lastName: true, lastContactAt: true, createdAt: true },
    orderBy: [{ lastContactAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }],
    take: MAX_CANDIDATES,
  });
  return decide(rankByName(q, candidates, now), limit);
}

/**
 * Narrows the leads worth scoring: a name word starting with the same letter as a typed word (typos
 * rarely hit the first letter), or sharing any three letters with one (they hit the first letter too).
 */
export function namePrefilter(typed: readonly string[]): Prisma.LeadWhereInput {
  const parts = new Set<string>();
  for (const w of typed) for (let i = 0; i + 3 <= w.length; i++) parts.add(w.slice(i, i + 3));
  const initials = new Set(typed.map((w) => w[0]));
  return {
    OR: [
      ...[...initials].flatMap((c) => [
        { firstName: { startsWith: c, mode: 'insensitive' as const } },
        { lastName: { startsWith: c, mode: 'insensitive' as const } },
      ]),
      ...[...parts].flatMap((p) => [
        { firstName: { contains: p, mode: 'insensitive' as const } },
        { lastName: { contains: p, mode: 'insensitive' as const } },
      ]),
    ],
  };
}
