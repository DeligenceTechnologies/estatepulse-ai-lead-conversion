import { NormalizedAnswer } from '../ingest/adapters/types';
import { CANONICAL_FIELDS, CanonicalKey, normalizeLabel } from './canonical-fields';
import type { Transform } from './transforms';

export interface Suggestion {
  sourceFieldKey: string;
  sourceFieldLabel: string;
  sourceFieldType: string;
  targetField: CanonicalKey;
  transform: Transform;
  confidence: number;
}

/** Dice coefficient over word tokens — tolerant of extra filler words. */
function similarity(a: string, b: string): number {
  const A = new Set(a.split(' ').filter(Boolean));
  const B = new Set(b.split(' ').filter(Boolean));
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared++;
  return (2 * shared) / (A.size + B.size);
}

/** Does this answer's shape betray what it is, regardless of its label? */
function shapeBonus(target: CanonicalKey, answer: NormalizedAnswer): number {
  const v = answer.scalarText;
  if (!v) return 0;
  if (target === 'email' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return 0.25;
  if (target === 'phone' && /^\+?[\d()\-.\s]{7,}$/.test(v)) return 0.2;
  if ((target === 'min_budget' || target === 'max_budget') && /\$|\d{3}[,.]?\d{3}|\d+\s*[kKmM]\b/.test(v)) return 0.15;
  return 0;
}

/** A CHECKBOXES field can never be a phone number, whatever its label says. */
function typeCompatible(target: CanonicalKey, providerType: string): boolean {
  const spec = CANONICAL_FIELDS[target];
  if (spec.providerTypes?.includes(providerType)) return true;

  const choice = ['DROPDOWN', 'MULTIPLE_CHOICE', 'CHECKBOXES', 'MULTI_SELECT'].includes(providerType);
  if (choice) {
    // A choice field can only feed an enum, a boolean, or free text.
    return ['timeline', 'buying_intent', 'financing_status', 'consent_status', 'location', 'bedrooms',
            'min_budget', 'max_budget', 'motivation'].includes(target);
  }
  if (providerType === 'INPUT_EMAIL') return target === 'email';
  if (providerType === 'INPUT_PHONE_NUMBER') return target === 'phone';
  return true;
}

function defaultTransform(target: CanonicalKey, answer: NormalizedAnswer, defaultRegion: string): Transform {
  switch (target) {
    case 'phone':
      return { kind: 'phone_e164', defaultRegion };
    case 'email':
      return { kind: 'email' };
    case 'bedrooms':
      return { kind: 'number' };
    case 'min_budget':
      return { kind: 'currency_range', part: 'min' };
    case 'max_budget':
      return { kind: 'currency_range', part: 'max' };
    case 'consent_status':
      return { kind: 'boolean' };
    case 'timeline':
    case 'buying_intent':
    case 'financing_status':
      return { kind: 'enum_map', byOptionText: autoEnumMap(target, answer), fallback: null };
    default:
      return { kind: 'text' };
  }
}

/**
 * Pre-fill an option-text -> enum map from the option set we just observed.
 *
 * This is the highest-leverage part of the heuristics: hand-mapping four
 * dropdown options is the tedious step that stops people finishing setup.
 */
function autoEnumMap(target: CanonicalKey, answer: NormalizedAnswer): Record<string, string> {
  // Full option set, falling back to selected values for providers that
  // do not send one.
  const options = answer.allOptions?.map((o) => o.text) ?? answer.textValues;
  const map: Record<string, string> = {};

  for (const opt of options) {
    const t = opt.toLowerCase();
    let mapped: string | null = null;

    if (target === 'timeline') {
      if (/asap|immediate|now|30 day|month\b|urgent/.test(t) && !/[3-9]|1[0-2]/.test(t.replace(/30/, '')))
        mapped = 'under_30_days';
      else if (/1\s*[-–to]+\s*3|one to three|1-3/.test(t)) mapped = '1_to_3_months';
      else if (/3\s*[-–to]+\s*6|three to six|3-6/.test(t)) mapped = '3_to_6_months';
      else if (/6\+|over 6|more than 6|browsing|just looking|next year/.test(t)) mapped = 'over_6_months';
      else if (/not sure|undecided|unsure/.test(t)) mapped = 'undecided';
    } else if (target === 'buying_intent') {
      if (/buy/.test(t)) mapped = 'buyer';
      else if (/sell/.test(t)) mapped = 'seller';
      else if (/invest/.test(t)) mapped = 'investor';
      else if (/not sure|both|undecided/.test(t)) mapped = 'undecided';
    } else if (target === 'financing_status') {
      if (/pre.?approved/.test(t)) mapped = 'pre_approved';
      else if (/cash/.test(t)) mapped = 'cash_buyer';
      else if (/need|looking for|lender|help/.test(t)) mapped = 'needs_lender';
      else if (/not|no\b/.test(t)) mapped = 'not_preapproved';
    }

    if (mapped) map[opt.trim().toLowerCase()] = mapped;
  }
  return map;
}

/**
 * Suggest a mapping for each observed question.
 *
 * Scoring order matters: the provider's FIELD TYPE is the dominant signal, not
 * the label. `INPUT_PHONE_NUMBER` means phone whether the label reads "Phone" or
 * "¿Cuál es tu número?" — types are reliable across customers, labels are not.
 */
export function suggestMappings(answers: NormalizedAnswer[], defaultRegion: string): Suggestion[] {
  const out: Suggestion[] = [];
  const claimed = new Set<CanonicalKey>();

  const scored: { answer: NormalizedAnswer; target: CanonicalKey; score: number }[] = [];

  for (const answer of answers) {
    const normLabel = normalizeLabel(answer.label);

    for (const target of Object.keys(CANONICAL_FIELDS) as CanonicalKey[]) {
      if (!typeCompatible(target, answer.type)) continue;

      const spec = CANONICAL_FIELDS[target];
      let score = 0;

      if (spec.providerTypes?.includes(answer.type)) score = 0.99;
      else {
        const syns = spec.synonyms ?? [];
        const exact = syns.some((s) => normLabel === normalizeLabel(s));
        if (exact) score = 0.9;
        else {
          const best = Math.max(0, ...syns.map((s) => similarity(normLabel, normalizeLabel(s))));
          if (best >= 0.5) score = 0.6 + best * 0.25;
        }
        score = Math.min(0.99, score + shapeBonus(target, answer));
      }

      if (score > 0) scored.push({ answer, target, score });
    }
  }

  // Highest confidence first so the strongest claim on each target wins.
  scored.sort((a, b) => b.score - a.score);

  for (const { answer, target, score } of scored) {
    if (score < 0.6) continue;

    // A budget question legitimately feeds BOTH min and max, so those two are
    // allowed to come from the same source field.
    const alreadyMappedThisPair = claimed.has(target);
    if (alreadyMappedThisPair) continue;
    if (out.some((s) => s.sourceFieldKey === answer.key && s.targetField === target)) continue;

    claimed.add(target);
    out.push({
      sourceFieldKey: answer.key,
      sourceFieldLabel: answer.label,
      sourceFieldType: answer.type,
      targetField: target,
      transform: defaultTransform(target, answer, defaultRegion),
      confidence: Number(score.toFixed(2)),
    });

    // A single "Full name" question must populate first AND last name.
    if (target === 'first_name' && !claimed.has('last_name') && /name/.test(normalizeLabel(answer.label))) {
      const looksFullName = !/first|given/.test(normalizeLabel(answer.label));
      if (looksFullName) {
        claimed.add('last_name');
        out.push({
          sourceFieldKey: answer.key,
          sourceFieldLabel: answer.label,
          sourceFieldType: answer.type,
          targetField: 'last_name',
          transform: { kind: 'name_split', part: 'last' },
          confidence: Number(score.toFixed(2)),
        });
        // The first-name side must split too, not take the whole string.
        const firstIdx = out.findIndex((s) => s.sourceFieldKey === answer.key && s.targetField === 'first_name');
        if (firstIdx >= 0) out[firstIdx].transform = { kind: 'name_split', part: 'first' };
      }
    }

    // One budget question fills both ends of the range.
    if (target === 'min_budget' && !claimed.has('max_budget')) {
      claimed.add('max_budget');
      out.push({
        sourceFieldKey: answer.key,
        sourceFieldLabel: answer.label,
        sourceFieldType: answer.type,
        targetField: 'max_budget',
        transform: { kind: 'currency_range', part: 'max' },
        confidence: Number(score.toFixed(2)),
      });
    }
  }

  return out;
}
