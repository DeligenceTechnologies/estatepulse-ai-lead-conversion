export type MergePolicy =
  | 'fill_if_empty'

  | 'latest_wins'

  | 'guarded';

export interface CanonicalField {
  column: string;
  label: string;
  group: 'Contact' | 'Property criteria' | 'Qualification' | 'Compliance';
  dataType: 'string' | 'int' | 'decimal' | 'bool' | 'phone' | 'email' | 'enum';
  merge: MergePolicy;
  requiredGroup?: 'contactable';
  providerTypes?: string[];
  synonyms?: string[];
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
    providerTypes: ['INPUT_EMAIL', 'email'],
    synonyms: ['email', 'e mail', 'email address', 'best email', 'contact email'],
  },
  phone: {
    column: 'phone',
    label: 'Phone',
    group: 'Contact',
    dataType: 'phone',
    merge: 'fill_if_empty',
    requiredGroup: 'contactable',
    providerTypes: ['INPUT_PHONE_NUMBER', 'phone_number'],
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

export const CANONICAL_FIELDS: Record<string, CanonicalField> = FIELDS;

export type CanonicalKey = keyof typeof FIELDS;

export const IGNORE_TARGET = '__ignore__';

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
