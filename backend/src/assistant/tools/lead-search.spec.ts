import { describe, expect, it, vi } from 'vitest';
import { CLEAR, decide, findLeads, nameScore, normalizeText, rankByName, trigramSimilarity, wordsOf, type Candidate } from './lead-search';

const NOW = new Date('2026-11-25T12:00:00Z');
const OLD = new Date('2026-06-01T12:00:00Z');
const YESTERDAY = new Date('2026-11-24T12:00:00Z');

let n = 0;
const lead = (firstName: string | null, lastName: string | null, lastContactAt: Date | null = null): Candidate => ({
  id: `lead-${++n}`,
  firstName,
  lastName,
  lastContactAt,
  createdAt: OLD,
});

/** Names of what a search decides for these leads, best first. */
function search(query: string, leads: Candidate[], limit = 10) {
  const byId = new Map(leads.map((l) => [l.id, `${l.firstName ?? ''} ${l.lastName ?? ''}`.trim()]));
  const outcome = decide(rankByName(query, leads, NOW), limit);
  return { match: outcome.match, names: outcome.ids.map((id) => byId.get(id)), total: outcome.total, closest: outcome.closest.map((id) => byId.get(id)) };
}

describe('lead search: text', () => {
  it('drops accents, case and punctuation', () => {
    expect(normalizeText('  José  O’Brien-Smith ')).toBe('jose o brien smith');
    expect(wordsOf('Zoë   Ng')).toEqual(['zoe', 'ng']);
  });

  it("measures words the way pg_trgm's similarity() does", () => {
    // "word" has 5 padded trigrams, "words" 6, and 4 are shared: 4 / (5 + 6 - 4). "sharm" 6, "sharma" 7, 5 shared.
    expect(trigramSimilarity('word', 'words')).toBeCloseTo(4 / 7, 5);
    expect(trigramSimilarity('sharma', 'sharm')).toBeCloseTo(0.625, 5);
    expect(trigramSimilarity('maria', 'maria')).toBe(1);
    expect(trigramSimilarity('abc', 'xyz')).toBe(0);
  });

  it('scores a whole first name as a full match even when the lead has a surname', () => {
    expect(nameScore(['rahul'], 'Rahul', 'Sharma')).toBe(1);
  });

  it('forgives a swapped or missing letter', () => {
    expect(nameScore(['jhon'], 'John', 'Smith')).toBeGreaterThanOrEqual(0.7);
    expect(nameScore(['shrma'], 'Rahul', 'Sharma')).toBeGreaterThanOrEqual(0.8);
  });

  it('uses each word of the name once', () => {
    // "Anna Anna" must not count both typed words against the one "Anna" of "Anna Lee".
    expect(nameScore(['anna', 'anna'], 'Anna', 'Lee')).toBeLessThan(0.8);
  });
});

describe('lead search: deciding', () => {
  it('a full name with one owner is a clear match', () => {
    expect(search('rahul sharma', [lead('Rahul', 'Sharma'), lead('Rahul', 'Verma'), lead('Priya', 'Sharma')])).toMatchObject({
      match: 'one',
      names: ['Rahul Sharma'],
    });
  });

  it('a first name two leads share is ambiguous, and both are offered', () => {
    const result = search('Rahul', [lead('Rahul', 'Sharma'), lead('Rahul', 'Verma'), lead('Priya', 'Patel')]);
    expect(result.match).toBe('ambiguous');
    expect(result.names.sort()).toEqual(['Rahul Sharma', 'Rahul Verma']);
    expect(result.total).toBe(2);
  });

  it('an initial settles it: "Rahul S" means Rahul Sharma', () => {
    expect(search('Rahul S', [lead('Rahul', 'Sharma'), lead('Rahul', 'Verma')])).toMatchObject({ match: 'one', names: ['Rahul Sharma'] });
  });

  it('recent contact orders two people of the same name, but does not pick one for the user', () => {
    const result = search('John Smith', [lead('John', 'Smith'), lead('John', 'Smith', YESTERDAY)]);
    expect(result.match).toBe('ambiguous');
    const ranked = rankByName('John Smith', [lead('John', 'Smith'), lead('John', 'Smith', YESTERDAY)], NOW);
    expect(ranked[0].score).toBeGreaterThan(ranked[1].score);
  });

  it('a typo still finds the person, offered for the user to confirm rather than acted on', () => {
    expect(search('Maria Lopes', [lead('Maria', 'Lopez'), lead('Priya', 'Shah')])).toMatchObject({ match: 'ambiguous', names: ['Maria Lopez'] });
  });

  it('a typo in a name being worked on right now is taken as that person', () => {
    expect(search('Maria Lopes', [lead('Maria', 'Lopez', YESTERDAY), lead('Priya', 'Shah')])).toMatchObject({ match: 'one', names: ['Maria Lopez'] });
  });

  it('a different surname is not passed off as the person: the only near name is ambiguous, not one', () => {
    expect(search('Maria Lopez', [lead('Maria', 'Gonzalez')])).toMatchObject({ match: 'ambiguous', names: ['Maria Gonzalez'] });
  });

  it('nothing close is none, with near names offered as closest', () => {
    const result = search('Rahool Kapoor', [lead('Rahul', 'Khanna'), lead('Zed', 'Quinn')]);
    expect(result).toMatchObject({ match: 'none', names: [], total: 0 });
    expect(result.closest).toEqual(['Rahul Khanna']);
  });

  it('several exact matches leave out names that only share the first name', () => {
    const result = search('Sunny Patel', [lead('Sunny', 'Patel'), lead('Sunny', 'Patel'), lead('Sunny', 'Shah', YESTERDAY)]);
    expect(result).toMatchObject({ match: 'ambiguous', names: ['Sunny Patel', 'Sunny Patel'], total: 2 });
  });

  it('ambiguous lists at most the limit, best first, and counts them all', () => {
    const leads = Array.from({ length: 8 }, (_, i) => lead('Anil', `Kumar${i}`));
    const result = search('anil', leads, 5);
    expect(result).toMatchObject({ match: 'ambiguous', total: 8 });
    expect(result.names).toHaveLength(5);
  });

  it('a clear match needs a clear lead over the next', () => {
    const outcome = decide(
      [
        { id: 'a', score: CLEAR + 0.05 },
        { id: 'b', score: CLEAR - 0.02 },
      ],
      10,
    );
    expect(outcome.match).toBe('ambiguous');
  });
});

describe('lead search: phone and email', () => {
  const setup = (ids: string[] = ['lead-1']) => {
    const prisma = { lead: { findMany: vi.fn(async () => ids.map((id) => ({ id }))) } };
    const scope = { orgId: 'org-1' };
    const matchOf = () => (prisma.lead.findMany.mock.calls[0] as any[])[0].where.AND[1];
    return { prisma, scope, matchOf };
  };

  it('a full phone number matches the stored E.164 number exactly, inside the scope', async () => {
    const s = setup();
    const outcome = await findLeads(s.prisma as any, s.scope, '+1 (512) 555-0101', 10, NOW);
    expect(outcome).toMatchObject({ match: 'one', ids: ['lead-1'] });
    expect((s.prisma.lead.findMany.mock.calls[0] as any[])[0].where.AND[0]).toBe(s.scope);
    expect(s.matchOf().OR).toContainEqual({ normalizedPhone: '+15125550101' });
  });

  it('a number typed without the country code, or its last digits, matches by ending', async () => {
    const s = setup();
    await findLeads(s.prisma as any, s.scope, '5550101', 10, NOW);
    expect(s.matchOf().OR).toEqual([{ normalizedPhone: { endsWith: '5550101' } }]);
  });

  it('two leads on one number are ambiguous', async () => {
    const s = setup(['lead-1', 'lead-2']);
    expect(await findLeads(s.prisma as any, s.scope, '+15125550101', 10, NOW)).toMatchObject({ match: 'ambiguous', total: 2 });
  });

  it('an email matches the normalized email exactly', async () => {
    const s = setup();
    await findLeads(s.prisma as any, s.scope, ' Maria@Example.com ', 10, NOW);
    expect(s.matchOf()).toEqual({ normalizedEmail: 'maria@example.com' });
  });

  it('no lead on that number is none', async () => {
    const s = setup([]);
    expect(await findLeads(s.prisma as any, s.scope, '+15125550199', 10, NOW)).toMatchObject({ match: 'none', ids: [] });
  });
});
