import type { CustomAuth, CustomTarget, EnumMapTransform, MappingField } from './customWebhookApi';

/**
 * The mapper screen offers ONE choice per source field; the API takes a list
 * of (path, target) pairs. These helpers are the translation, the checks the
 * screen runs before a round trip, and the wording around them.
 */

export type TargetChoice = CustomTarget | '';

export const TARGET_CHOICES: { value: TargetChoice; label: string; /** Only offered when the field came with an option map (a form's choice question). */ enumOnly?: boolean }[] = [
  { value: '', label: 'Don’t import' },
  { value: 'full_name', label: 'Full name (split into first + last)' },
  { value: 'first_name', label: 'First name' },
  { value: 'last_name', label: 'Last name' },
  { value: 'phone', label: 'Phone' },
  { value: 'email', label: 'Email' },
  { value: 'location', label: 'Location' },
  { value: 'budget_range', label: 'Budget (range → min + max)' },
  { value: 'min_budget', label: 'Budget minimum' },
  { value: 'max_budget', label: 'Budget maximum' },
  { value: 'bedrooms', label: 'Bedrooms' },
  { value: 'motivation', label: 'Notes / motivation' },
  { value: 'consent_status', label: 'SMS/call consent (yes/no)' },
  { value: 'timeline', label: 'Timeline (from the question’s options)', enumOnly: true },
  { value: 'buying_intent', label: 'Intent (from the question’s options)', enumOnly: true },
  { value: 'financing_status', label: 'Financing (from the question’s options)', enumOnly: true },
  { value: 'utm_source', label: 'UTM source' },
  { value: 'utm_medium', label: 'UTM medium' },
  { value: 'utm_campaign', label: 'UTM campaign' },
  { value: '__custom__', label: 'Keep as an extra field' },
];

export const FIELD_LABEL: Record<string, string> = {
  first_name: 'First name',
  last_name: 'Last name',
  phone: 'Phone',
  email: 'Email',
  location: 'Location',
  min_budget: 'Budget min',
  max_budget: 'Budget max',
  bedrooms: 'Bedrooms',
  motivation: 'Notes',
  consent_status: 'Consent',
  timeline: 'Timeline',
  buying_intent: 'Intent',
  financing_status: 'Financing',
  utm_source: 'UTM source',
  utm_medium: 'UTM medium',
  utm_campaign: 'UTM campaign',
};

const ENUM_TARGETS: CustomTarget[] = ['timeline', 'buying_intent', 'financing_status'];
export const isEnumTarget = (t: TargetChoice): boolean => ENUM_TARGETS.includes(t as CustomTarget);

/** One row of the mapper per source field. */
export interface DraftRow {
  target: TargetChoice;
  customName: string;
  /** The option map the suggestion came with, kept so an enum target can be saved. */
  transform?: EnumMapTransform;
}
export type Draft = Record<string, DraftRow>;

export function draftFromFields(fields: MappingField[]): Draft {
  const out: Draft = {};
  for (const f of fields) out[f.path] = { target: f.target, customName: f.customName ?? '', ...(f.transform ? { transform: f.transform } : {}) };
  return out;
}

/** Fields left at "Don’t import" are simply absent from the API list. */
export function fieldsFromDraft(draft: Draft): MappingField[] {
  const out: MappingField[] = [];
  for (const [path, row] of Object.entries(draft)) {
    if (!row.target) continue;
    if (row.target === '__custom__') out.push({ path, target: row.target, customName: row.customName.trim() });
    else if (isEnumTarget(row.target) && row.transform) out.push({ path, target: row.target, transform: row.transform });
    else out.push({ path, target: row.target });
  }
  return out;
}

const claims = (target: CustomTarget): string[] =>
  target === 'full_name' ? ['first_name', 'last_name'] : target === 'budget_range' ? ['min_budget', 'max_budget'] : target === '__custom__' ? [] : [target];

/**
 * Quick checks before saving, so the owner sees what is missing without a
 * round trip. The server checks everything again.
 */
export function draftProblems(fields: MappingField[]): string[] {
  const problems: string[] = [];
  const filled = new Map<string, number>();
  const names = new Set<string>();
  for (const f of fields) {
    for (const c of claims(f.target)) filled.set(c, (filled.get(c) ?? 0) + 1);
    if (f.target === '__custom__') {
      const name = (f.customName ?? '').trim().toLowerCase();
      if (!name) problems.push(`Name the extra field for ${f.path}.`);
      else if (names.has(name)) problems.push(`Two paths are both named "${f.customName}".`);
      names.add(name);
    }
    if (isEnumTarget(f.target) && !f.transform) problems.push(`${FIELD_LABEL[f.target]} needs a question with options; ${f.path} has none.`);
  }
  if (!filled.has('phone') && !filled.has('email')) problems.push('Choose the field with the phone or the email.');
  for (const [field, n] of filled) {
    if (n > 1) problems.push(`${FIELD_LABEL[field] ?? field} is filled from more than one field.`);
  }
  return problems;
}

/**
 * How the sending app proves itself, as the setup screen offers it. The two
 * form presets are the providers' own signature schemes, so the owner pastes
 * our secret into the form tool and nothing else is configured.
 */
export interface AuthPreset {
  id: 'header' | 'tally' | 'typeform' | 'hmac' | 'basic' | 'none';
  label: string;
  hint: string;
  /** Fixed auth for a preset; undefined when the form below completes it. */
  auth?: CustomAuth;
}

export const AUTH_PRESETS: AuthPreset[] = [
  { id: 'header', label: 'A secret in a header (simplest)', hint: 'Zapier, Make, your own code: send the secret in a header on every request.' },
  {
    id: 'tally',
    label: 'Tally form (signature)',
    hint: 'Paste the URL and the secret into Tally → Integrations → Webhooks. Submissions are read as a form.',
    auth: { mode: 'hmac', headerName: 'tally-signature', algorithm: 'sha256', encoding: 'base64' },
  },
  {
    id: 'typeform',
    label: 'Typeform (signature)',
    hint: 'Paste the URL and the secret into Typeform → Connect → Webhooks.',
    auth: { mode: 'hmac', headerName: 'typeform-signature', algorithm: 'sha256', encoding: 'base64', prefix: 'sha256=' },
  },
  { id: 'hmac', label: 'An HMAC signature of the body (custom)', hint: 'Choose the header, algorithm and encoding your app signs with.' },
  { id: 'basic', label: 'HTTP basic auth', hint: 'A username you choose and a password we mint.' },
  { id: 'none', label: 'Nothing — the URL alone', hint: 'The unguessable URL is the only secret. Fine for a quick test.' },
];

const SAMPLE_BODY = '{"name":"Jane Doe","phone":"+1 512 555 0101","email":"jane@example.com"}';

/** A curl command the owner can run to send the first payload. */
export function curlExample(url: string, auth: CustomAuth, secret: string | null): string {
  const lines = [`curl -X POST '${url}'`, `  -H 'Content-Type: application/json'`];
  const sec = secret ?? '<your secret>';
  switch (auth.mode) {
    case 'none':
      break;
    case 'header_secret':
      lines.push(`  -H '${auth.headerName}: ${sec}'`);
      break;
    case 'basic':
      lines.push(`  -u '${auth.username}:${sec}'`);
      break;
    case 'hmac': {
      const digest = auth.encoding === 'hex' ? `openssl dgst -${auth.algorithm} -hmac "$SECRET" -hex | sed 's/^.* //'` : `openssl dgst -${auth.algorithm} -hmac "$SECRET" -binary | base64`;
      return [
        `BODY='${SAMPLE_BODY}'`,
        `SECRET='${sec}'`,
        `SIG=$(printf '%s' "$BODY" | ${digest})`,
        `curl -X POST '${url}'`,
        `  -H 'Content-Type: application/json'`,
        `  -H '${auth.headerName}: ${auth.prefix ?? ''}'"$SIG"`,
        `  -d "$BODY"`,
      ].join(' \\\n');
    }
  }
  lines.push(`  -d '${SAMPLE_BODY}'`);
  return lines.join(' \\\n');
}

/** One word for where a webhook stands, from the summary every list carries. */
export function customStatus(s: { ingestStatus: string | null; mappingStatus: string | null; isActive: boolean }): { label: string; cls: string } {
  const ingest = (s.ingestStatus ?? '').toUpperCase();
  const mapping = (s.mappingStatus ?? '').toUpperCase();
  if (ingest === 'PAUSED' || !s.isActive) return { label: 'paused', cls: 'bg-slate-800 text-slate-400 border-slate-700' };
  if (ingest === 'ACTIVE') return { label: 'active', cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40' };
  if (ingest === 'NEEDS_MAPPING' && mapping === 'CONFIGURED') return { label: 'ready to switch on', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' };
  if (ingest === 'NEEDS_MAPPING') return { label: 'needs mapping', cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40' };
  return { label: 'waiting for payload', cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30' };
}
