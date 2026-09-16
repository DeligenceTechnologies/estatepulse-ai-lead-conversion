/**
 * The canonical target registry.
 *
 * Deliberately code, not data: it changes with deploys, must be type-checked
 * against the real `leads` columns, and drives the mapping UI, the completeness
 * validator and the merge policy from one place.
 */

export type MergePolicy =
  /** First writer wins; a later submission only fills a blank. */
  | 'fill_if_empty'
  /** Intent that legitimately changes over time — the newest answer wins. */
  | 'latest_wins'
  /** Compliance field with its own rules; never a plain overwrite. */
  | 'guarded';

export interface CanonicalField {
  /** Column on `leads`. */
  column: string;
  label: string;
  group: 'Contact' | 'Property criteria' | 'Qualification' | 'Compliance';
  dataType: 'string' | 'int' | 'decimal' | 'bool' | 'phone' | 'email' | 'enum';
  merge: MergePolicy;
  /** At least one of the `contactable` group must be present to create a lead. */
  requiredGroup?: 'contactable';
  /** Tally field types that unambiguously imply this target. */
  providerTypes?: string[];
  /** Normalized label fragments that suggest this target. */
  synonyms?: string[];
  /**
   * Fragments that RULE OUT this target, whatever the similarity score says.
   *
   * Fuzzy label matching cannot tell near-opposites apart: "first name" scores
   * 0.78 against "last name" on bigram similarity, which is well above the
   * threshold. On a form with no surname question that is enough for the first
   * name to claim `last_name` too, and every lead ends up called "Priya Priya".
   * One explicit veto is cheaper and far more legible than tuning the score.
   */
  disqualifiers?: string[];
  enumValues?: string[];
}

const FIELDS = {
  first_name: {
    column: 'first_name',
    label: 'First name',
    group: 'Contact',
    dataType: 'string',
    merge: 'fill_if_empty',
    synonyms: ['first name', 'given name', 'name', 'your name', 'full name', 'what should we call you'],
    disqualifiers: ['last name', 'surname', 'family name'],
  },
  last_name: {
    column: 'last_name',
    label: 'Last name',
    group: 'Contact',
    dataType: 'string',
    merge: 'fill_if_empty',
    synonyms: ['last name', 'surname', 'family name'],
    disqualifiers: ['first name', 'given name'],
  },
  email: {
    column: 'email',
    label: 'Email',
    group: 'Contact',
    dataType: 'email',
    merge: 'fill_if_empty',
    requiredGroup: 'contactable',
    providerTypes: ['INPUT_EMAIL'],
    synonyms: ['email', 'e mail', 'email address', 'best email', 'contact email'],
  },
  phone: {
    column: 'phone',
    label: 'Phone',
    group: 'Contact',
    dataType: 'phone',
    // Phone is the primary identity and the channel we dial, so the first
    // verified number is sticky — a later submission does not silently
    // repoint outreach at a different number.
    merge: 'fill_if_empty',
    requiredGroup: 'contactable',
    providerTypes: ['INPUT_PHONE_NUMBER'],
    synonyms: [
      'phone', 'phone number', 'mobile', 'cell', 'cell phone', 'best number',
      'contact number', 'number we can reach you on', 'whatsapp', 'how can we reach you',
    ],
  },
  location: {
    column: 'location',
    label: 'Preferred location',
    group: 'Property criteria',
    dataType: 'string',
    merge: 'latest_wins',
    synonyms: ['location', 'area', 'areas', 'neighborhood', 'neighbourhood', 'city', 'where', 'suburb', 'zip'],
  },
  min_budget: {
    column: 'min_budget',
    label: 'Budget (min)',
    group: 'Property criteria',
    dataType: 'decimal',
    merge: 'latest_wins',
    synonyms: ['budget', 'price range', 'min budget', 'minimum budget', 'how much'],
  },
  max_budget: {
    column: 'max_budget',
    label: 'Budget (max)',
    group: 'Property criteria',
    dataType: 'decimal',
    merge: 'latest_wins',
    synonyms: ['budget', 'price range', 'max budget', 'maximum budget', 'purchase price'],
  },
  bedrooms: {
    column: 'bedrooms',
    label: 'Bedrooms',
    group: 'Property criteria',
    dataType: 'int',
    merge: 'latest_wins',
    synonyms: ['bedrooms', 'beds', 'how many bedrooms', 'bed'],
  },
  timeline: {
    column: 'timeline',
    label: 'Timeline',
    group: 'Qualification',
    dataType: 'enum',
    merge: 'latest_wins',
    enumValues: ['under_30_days', '1_to_3_months', '3_to_6_months', 'over_6_months', 'undecided'],
    synonyms: [
      'timeline', 'timeframe', 'time frame', 'when are you looking', 'when do you want',
      'how soon', 'when are you hoping to move', 'move in', 'moving',
    ],
  },
  buying_intent: {
    column: 'buying_intent',
    label: 'Intent',
    group: 'Qualification',
    dataType: 'enum',
    merge: 'latest_wins',
    enumValues: ['buyer', 'seller', 'investor', 'undecided'],
    synonyms: ['buying or selling', 'are you buying', 'intent', 'looking to'],
  },
  financing_status: {
    column: 'financing_status',
    label: 'Financing',
    group: 'Qualification',
    dataType: 'enum',
    merge: 'latest_wins',
    enumValues: ['pre_approved', 'cash_buyer', 'needs_lender', 'not_preapproved', 'unknown'],
    synonyms: ['financing', 'pre approved', 'preapproved', 'pre approval', 'mortgage', 'lender', 'cash'],
  },
  motivation: {
    column: 'motivation',
    label: 'Motivation / notes',
    group: 'Qualification',
    dataType: 'string',
    merge: 'latest_wins',
    synonyms: ['motivation', 'why', 'tell us more', 'anything else', 'comments', 'message'],
  },
  consent_status: {
    column: 'consent_status',
    label: 'SMS/call consent',
    group: 'Compliance',
    dataType: 'bool',
    merge: 'guarded',
    synonyms: [
      'consent', 'opt in', 'agree to receive', 'text me', 'sms updates',
      'contact me', 'permission', 'i agree',
    ],
  },
} satisfies Record<string, CanonicalField>;

/**
 * Exported as a plain Record so optional members (providerTypes, synonyms,
 * enumValues) stay visible. `as const` would narrow each entry to its own
 * literal type, and accessing `.providerTypes` on the resulting union fails to
 * compile for every entry that happens not to declare one.
 */
export const CANONICAL_FIELDS: Record<string, CanonicalField> = FIELDS;

export type CanonicalKey = keyof typeof FIELDS;

export const CANONICAL_KEYS = Object.keys(FIELDS) as CanonicalKey[];

/** Sentinel for a question the user deliberately chose not to map. */
export const IGNORE_TARGET = '__ignore__';

/** Lowercase, strip punctuation/emoji and filler, collapse whitespace. */
export function normalizeLabel(label: string): string {
  return label
    .toLowerCase()
    .replace(/[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/gu, ' ')
    .replace(/\(required\)|\*/g, ' ')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\b(your|please|the|a|an|is|are|do|you|we|us|what|which|s)\b/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
