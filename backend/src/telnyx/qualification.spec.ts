import { describe, expect, it } from 'vitest';
import { EXTRACTION_INSTRUCTIONS, parseExtraction } from './lead-scoring';
import {
  coerceAnswer,
  extractionInstructionsFor,
  extractionJsonSchemaFor,
  memoryVariables,
  mergeAnswers,
  normalizeQuestions,
  NOTHING_KNOWN,
  NOTHING_TO_ASK,
  QUALIFICATION_PROMPT_START,
  questionsHash,
  storedAnswers,
  withQualificationSection,
  withoutQualificationSection,
  type LeadMemoryFields,
  type Question,
} from './qualification';

const custom: Question[] = [
  { key: 'property_type', label: 'Property type', question: 'House or condo?', type: 'choice', options: ['House', 'Condo'], enabled: true, builtin: false },
  { key: 'has_agent', label: 'Has agent', question: 'Are you working with an agent?', type: 'boolean', enabled: true, builtin: false },
  { key: 'parking', label: 'Parking', question: 'How many parking spots?', type: 'number', enabled: false, builtin: false },
];
const questions = normalizeQuestions(custom);

const emptyLead: LeadMemoryFields = {
  timeline: null,
  location: null,
  minBudget: null,
  maxBudget: null,
  bedrooms: null,
  financingStatus: null,
  motivation: null,
  qualificationAnswers: {},
};

describe('normalizeQuestions', () => {
  it('keeps every built-in, disabling the ones left out', () => {
    expect(questions.map((q) => q.key)).toEqual(['property_type', 'has_agent', 'parking', 'timeline', 'location', 'budget', 'bedrooms', 'financing', 'motivation']);
    expect(questions.find((q) => q.key === 'budget')).toMatchObject({ builtin: true, enabled: false });
  });

  it('drops bad keys, duplicates and choice questions without options', () => {
    const out = normalizeQuestions([
      { key: 'Bad Key', label: 'x', question: 'x?', type: 'text', enabled: true },
      { key: 'ok', label: 'Ok', question: 'Ok?', type: 'text', enabled: true },
      { key: 'ok', label: 'Dup', question: 'Dup?', type: 'text', enabled: true },
      { key: 'pick', label: 'Pick', question: 'Pick?', type: 'choice', options: [], enabled: true },
    ]);
    expect(out.filter((q) => !q.builtin).map((q) => q.label)).toEqual(['Ok']);
  });

  it('defaults to the built-ins, all enabled', () => {
    expect(normalizeQuestions(null).every((q) => q.builtin && q.enabled)).toBe(true);
  });
});

describe('extractionJsonSchemaFor', () => {
  it('adds an answers object for enabled custom questions only', () => {
    const schema = extractionJsonSchemaFor(questions) as any;
    expect(schema.required).toContain('answers');
    expect(Object.keys(schema.properties.answers.properties)).toEqual(['property_type', 'has_agent']);
    expect(schema.properties.answers.properties.property_type.enum).toEqual(['House', 'Condo', null]);
  });

  it('is the fixed schema when there are no custom questions', () => {
    expect((extractionJsonSchemaFor(normalizeQuestions(null)) as any).properties.answers).toBeUndefined();
  });

  it('hash changes only when extraction changes', () => {
    const relabelled = questions.map((q) => (q.key === 'has_agent' ? { ...q, label: 'Agent?' } : q));
    const reworded = questions.map((q) => (q.key === 'has_agent' ? { ...q, question: 'Do you have an agent?' } : q));
    expect(questionsHash(relabelled)).toBe(questionsHash(questions));
    expect(questionsHash(reworded)).not.toBe(questionsHash(questions));
  });
});

describe('parseExtraction', () => {
  it('keeps the answers object', () => {
    const x = parseExtraction({
      timeline: 'unknown', budget_identified: false, location_identified: false, pre_approved: false,
      appointment_requested: false, high_engagement: false, not_interested: false, invalid_lead: false,
      human_requested: false, callback_requested: false, summary: 's', budget_min: null, budget_max: null,
      location: null, bedrooms: null, financing: null, motivation: null,
      answers: { property_type: 'Condo', has_agent: null },
    });
    expect(x?.answers).toEqual({ property_type: 'Condo', has_agent: null });
  });
});

describe('mergeAnswers', () => {
  const t1 = new Date('2026-10-01T10:00:00Z');
  const t2 = new Date('2026-10-02T10:00:00Z');

  it('stores non-null answers that fit the question, skipping disabled ones', () => {
    const { answers, changed } = mergeAnswers({}, { property_type: 'condo', has_agent: null, parking: 2 }, questions, t1, 'call', 'c1');
    expect(changed).toBe(true);
    expect(answers).toEqual({ property_type: { value: 'Condo', at: t1.toISOString(), source: 'call', refId: 'c1' } });
  });

  it('overwrites with a correction from a later call, never with an older one', () => {
    const first = mergeAnswers({}, { property_type: 'House' }, questions, t1, 'call', 'c1').answers;
    expect(mergeAnswers(first, { property_type: 'Condo' }, questions, t2, 'call', 'c2').answers.property_type.value).toBe('Condo');
    const later = mergeAnswers({}, { property_type: 'Condo' }, questions, t2, 'call', 'c2').answers;
    expect(mergeAnswers(later, { property_type: 'House' }, questions, t1, 'call', 'c1')).toMatchObject({ changed: false });
  });

  it('never overrides an answer a person entered', () => {
    const manual = { property_type: { value: 'House', at: t1.toISOString(), source: 'manual' as const } };
    expect(mergeAnswers(manual, { property_type: 'Condo' }, questions, t2, 'sms').changed).toBe(false);
  });

  it('records where a text-chat answer came from', () => {
    expect(mergeAnswers({}, { has_agent: 'yes' }, questions, t1, 'sms', 'm1').answers.has_agent).toEqual({ value: true, at: t1.toISOString(), source: 'sms', refId: 'm1' });
  });

  it('ignores answers outside a choice list', () => {
    expect(mergeAnswers({}, { property_type: 'Castle' }, questions, t1, 'call', 'c1').changed).toBe(false);
  });
});

describe('memoryVariables', () => {
  it('asks everything for a new lead', () => {
    const v = memoryVariables(questions, emptyLead);
    expect(v.knownInfo).toBe(NOTHING_KNOWN);
    expect(v.questionsToAsk).toBe('1. House or condo? (House / Condo)\n2. Are you working with an agent?');
    expect(v.nextQuestion).toBe('House or condo?');
  });

  it('moves answered questions, built-in or custom, from asking to known', () => {
    const all = normalizeQuestions([...custom, { key: 'budget', label: 'Budget', question: 'Budget?', type: 'text', enabled: true }]);
    const lead = {
      ...emptyLead,
      minBudget: 400000,
      maxBudget: 500000,
      qualificationAnswers: { has_agent: { value: false, at: '2026-10-01T00:00:00Z', source: 'call' } },
    };
    const v = memoryVariables(all, lead);
    expect(v.knownInfo).toBe('- Has agent: No\n- Budget: 400,000 to 500,000');
    expect(v.questionsToAsk).toBe('1. House or condo? (House / Condo)');
  });

  it('says so when nothing is left', () => {
    const lead = { ...emptyLead, qualificationAnswers: { property_type: { value: 'House', at: 'x', source: 'call' }, has_agent: { value: true, at: 'x', source: 'call' } } };
    expect(memoryVariables(questions, lead)).toMatchObject({ questionsToAsk: NOTHING_TO_ASK, nextQuestion: '' });
  });
});

describe('qualification prompt section', () => {
  it('is added once and replaced, not duplicated', () => {
    const once = withQualificationSection('# Role\nBe nice.');
    const twice = withQualificationSection(once);
    expect(twice).toBe(once);
    expect(twice.split(QUALIFICATION_PROMPT_START).length).toBe(2);
    expect(twice).toContain('{{knownInfo}}');
    expect(withoutQualificationSection(twice)).toBe('# Role\nBe nice.');
  });

  it('keeps text after the section when removed', () => {
    const withTail = `${withQualificationSection('A')}\n\nB`;
    expect(withoutQualificationSection(withTail)).toBe('A\n\nB');
  });
});

const q = (over: Partial<Question>): Question => ({ key: 'k', label: 'K', question: 'K?', type: 'text', enabled: true, builtin: false, ...over });

describe('normalizeQuestions edge cases', () => {
  it('keeps a built-in type fixed, whatever the saved list says', () => {
    const out = normalizeQuestions([{ key: 'bedrooms', label: 'Beds', question: 'Beds?', type: 'choice', options: ['1'], enabled: true }]);
    expect(out.find((x) => x.key === 'bedrooms')).toMatchObject({ type: 'number', builtin: true, label: 'Beds' });
  });

  it('trims choice options and drops empty or repeated ones', () => {
    const out = normalizeQuestions([{ key: 'kind', label: 'Kind', question: 'Kind?', type: 'choice', options: [' Plot ', 'Flat', '', 'Flat'], enabled: true }]);
    expect(out[0].options).toEqual(['Plot', 'Flat']);
  });

  it('treats an unknown type as text and a missing "enabled" as on', () => {
    expect(normalizeQuestions([{ key: 'odd', label: 'Odd', question: 'Odd?', type: 'date' }])[0]).toMatchObject({ type: 'text', enabled: true });
  });

  it('drops a custom question without question text, and fills a built-in one from the default', () => {
    const out = normalizeQuestions([
      { key: 'blank', label: 'Blank', question: '   ', type: 'text', enabled: true },
      { key: 'timeline', label: '', question: '', enabled: true },
    ]);
    expect(out.some((x) => x.key === 'blank')).toBe(false);
    expect(out.find((x) => x.key === 'timeline')).toMatchObject({ label: 'Timeline', question: 'When are you hoping to buy?' });
  });

  it('caps the list at 30 custom questions plus the built-ins', () => {
    const many = Array.from({ length: 40 }, (_, i) => ({ key: `q${i}`, label: `Q${i}`, question: `Q${i}?`, type: 'text', enabled: true }));
    expect(normalizeQuestions(many)).toHaveLength(36);
  });

  it('ignores items that are not objects', () => {
    expect(normalizeQuestions([null, 'x', 3, { key: 'ok', label: 'Ok', question: 'Ok?' }]).filter((x) => !x.builtin)).toHaveLength(1);
  });
});

describe('coerceAnswer', () => {
  it('reads numbers written with separators, and refuses words', () => {
    expect(coerceAnswer(q({ type: 'number' }), '1,200')).toBe(1200);
    expect(coerceAnswer(q({ type: 'number' }), 5)).toBe(5);
    expect(coerceAnswer(q({ type: 'number' }), 'five')).toBeNull();
  });

  it('reads yes / no and refuses a maybe', () => {
    const yn = q({ type: 'boolean' });
    expect(coerceAnswer(yn, 'Yes')).toBe(true);
    expect(coerceAnswer(yn, 'false')).toBe(false);
    expect(coerceAnswer(yn, false)).toBe(false);
    expect(coerceAnswer(yn, 'maybe')).toBeNull();
  });

  it('matches a choice whatever its case, and returns the option as written', () => {
    const choice = q({ type: 'choice', options: ['Plot', 'Flat'] });
    expect(coerceAnswer(choice, ' flat ')).toBe('Flat');
    expect(coerceAnswer(choice, 'Villa')).toBeNull();
  });

  it('trims text, caps it at 500 characters and refuses an empty answer', () => {
    expect(coerceAnswer(q({}), '  near a school ')).toBe('near a school');
    expect(String(coerceAnswer(q({}), 'x'.repeat(900))).length).toBe(500);
    expect(coerceAnswer(q({}), '   ')).toBeNull();
    expect(coerceAnswer(q({}), null)).toBeNull();
  });
});

describe('storedAnswers', () => {
  it('keeps only well-formed answers', () => {
    expect(
      storedAnswers({
        good: { value: 'Flat', at: '2026-10-01T00:00:00Z', source: 'call' },
        noValue: { value: null, at: '2026-10-01T00:00:00Z', source: 'call' },
        noDate: { value: 'x', source: 'call' },
        junk: 'x',
      }),
    ).toEqual({ good: { value: 'Flat', at: '2026-10-01T00:00:00Z', source: 'call' } });
  });

  it('is empty for anything that is not an object', () => {
    expect(storedAnswers(null)).toEqual({});
    expect(storedAnswers([1, 2])).toEqual({});
    expect(storedAnswers('x')).toEqual({});
  });
});

describe('mergeAnswers edge cases', () => {
  const t1 = new Date('2026-10-01T10:00:00Z');
  const t2 = new Date('2026-10-02T10:00:00Z');

  it('reports no change when the answer is the same', () => {
    const first = mergeAnswers({}, { property_type: 'House' }, questions, t1, 'call', 'c1').answers;
    expect(mergeAnswers(first, { property_type: 'house' }, questions, t2, 'sms', 'm1')).toEqual({ answers: first, changed: false });
  });

  it('never clears a stored answer when the new conversation said nothing', () => {
    const first = mergeAnswers({}, { property_type: 'House' }, questions, t1, 'call', 'c1').answers;
    expect(mergeAnswers(first, { property_type: null }, questions, t2, 'call', 'c2')).toEqual({ answers: first, changed: false });
    expect(mergeAnswers(first, undefined, questions, t2, 'call', 'c2').changed).toBe(false);
  });

  it('ignores keys that are not an enabled custom question', () => {
    expect(mergeAnswers({}, { unknown_key: 'x', budget: '500k' }, questions, t1, 'call').changed).toBe(false);
  });

  it('keeps other answers when one is updated', () => {
    const first = mergeAnswers({}, { property_type: 'House', has_agent: true }, questions, t1, 'call', 'c1').answers;
    const next = mergeAnswers(first, { property_type: 'Condo' }, questions, t2, 'sms', 'm1').answers;
    expect(next.has_agent).toEqual(first.has_agent);
    expect(next.property_type).toMatchObject({ value: 'Condo', source: 'sms' });
  });

  it('leaves the stored answers it was given untouched', () => {
    const current = {};
    mergeAnswers(current, { property_type: 'House' }, questions, t1, 'call');
    expect(current).toEqual({});
  });
});

describe('memoryVariables edge cases', () => {
  const budgetOnly = normalizeQuestions([{ key: 'budget', label: 'Budget', question: 'Budget?', enabled: true }]);
  const known = (minBudget: number | null, maxBudget: number | null) => memoryVariables(budgetOnly, { ...emptyLead, minBudget, maxBudget }).knownInfo;

  it('writes a budget as a single figure, a ceiling or a floor', () => {
    expect(known(300000, 300000)).toBe('- Budget: 300,000');
    expect(known(null, 300000)).toBe('- Budget: up to 300,000');
    expect(known(250000, null)).toBe('- Budget: from 250,000');
  });

  it('counts a blank text field as not answered', () => {
    const v = memoryVariables(normalizeQuestions(null), { ...emptyLead, location: '   ' });
    expect(v.questionsToAsk).toContain('Which area or neighbourhood are you looking in?');
  });

  it('asks every enabled question when no lead is known (the assistant defaults)', () => {
    const v = memoryVariables(questions, null);
    expect(v.knownInfo).toBe(NOTHING_KNOWN);
    expect(v.questionsToAsk.split('\n')).toHaveLength(2);
  });

  it('never lists a disabled question, answered or not', () => {
    const lead = { ...emptyLead, qualificationAnswers: { parking: { value: 2, at: 'x', source: 'call' } } };
    const v = memoryVariables(questions, lead);
    expect(v.knownInfo).not.toContain('Parking');
    expect(v.questionsToAsk).not.toContain('parking');
  });
});

describe('extractionInstructionsFor', () => {
  it('is the fixed instructions without custom questions', () => {
    expect(extractionInstructionsFor(normalizeQuestions(null))).toBe(EXTRACTION_INSTRUCTIONS);
  });

  it('asks only for answers given in this conversation', () => {
    expect(extractionInstructionsFor(questions)).toContain('THIS conversation');
  });
});

describe('qualification prompt section placeholders', () => {
  it('carries every memory variable the server fills', () => {
    const section = withQualificationSection('');
    for (const v of ['{{knownInfo}}', '{{questionsToAsk}}', '{{conversationSummary}}']) expect(section).toContain(v);
  });

  it('replaces a section left without its end marker', () => {
    const broken = `A\n\n${QUALIFICATION_PROMPT_START}\nold text`;
    expect(withQualificationSection(broken).split(QUALIFICATION_PROMPT_START).length).toBe(2);
  });
});
