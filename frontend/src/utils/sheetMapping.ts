import type { ApproveResult, ColumnMapping, Identity, RejectResult } from './googleSheetsApi';
import { startLabel } from './outreachApi';

/**
 * The mapping screen offers ONE choice per column; the API takes a list of
 * (column, field) pairs, where a single column can fill two fields (a full name
 * split into first + last, a budget range into min + max). These helpers are
 * the translation, plus the owner-facing wording for codes the API returns.
 */

export type ColumnChoice =
  | ''
  | 'full_name'
  | 'first_name'
  | 'last_name'
  | 'phone'
  | 'email'
  | 'location'
  | 'budget_range'
  | 'min_budget'
  | 'max_budget'
  | 'bedrooms'
  | 'motivation'
  | '__custom__';

export const CHOICES: { value: ColumnChoice; label: string }[] = [
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
  { value: '__custom__', label: 'Keep as an extra field' },
];

/** API pairs -> one choice per column. */
export function choicesFromColumns(columns: ColumnMapping[]): Record<string, ColumnChoice> {
  const byKey = new Map<string, Set<string>>();
  for (const c of columns) byKey.set(c.fieldKey, (byKey.get(c.fieldKey) ?? new Set()).add(c.target));
  const out: Record<string, ColumnChoice> = {};
  for (const [key, targets] of byKey) {
    if (targets.has('min_budget') && targets.has('max_budget')) out[key] = 'budget_range';
    else out[key] = [...targets][0] as ColumnChoice;
  }
  return out;
}

/** One choice per column -> API pairs. */
export function columnsFromChoices(choices: Record<string, ColumnChoice>): ColumnMapping[] {
  const out: ColumnMapping[] = [];
  for (const [fieldKey, choice] of Object.entries(choices)) {
    if (!choice) continue;
    if (choice === 'budget_range') {
      out.push({ fieldKey, target: 'min_budget' }, { fieldKey, target: 'max_budget' });
    } else {
      out.push({ fieldKey, target: choice });
    }
  }
  return out;
}

/**
 * Quick checks before saving, so the owner sees what is missing without a round
 * trip. The server checks everything again against the sheet as it is now.
 */
export function draftProblems(
  choices: Record<string, ColumnChoice>,
  identity: Identity | null,
  fallbackAcknowledged: boolean,
): string[] {
  const filled = new Map<string, number>();
  for (const c of columnsFromChoices(choices)) {
    const fields = c.target === 'full_name' ? ['first_name', 'last_name'] : c.target === '__custom__' ? [] : [c.target];
    for (const f of fields) filled.set(f, (filled.get(f) ?? 0) + 1);
  }
  const problems: string[] = [];
  if (!filled.has('first_name')) problems.push('Choose the column with the lead’s name.');
  if (!filled.has('phone') && !filled.has('email')) problems.push('Choose a phone or an email column.');
  for (const [field, n] of filled) {
    if (n > 1) problems.push(`${FIELD_LABEL[field] ?? field} is filled from more than one column.`);
  }
  if (!identity) problems.push('Choose how rows are recognised.');
  else if (identity.mode === 'column' && !identity.fieldKey) problems.push('Choose the ID column.');
  else if (identity.mode === 'fallback' && !fallbackAcknowledged) {
    problems.push('Confirm you understand how rows are matched without an ID column.');
  }
  return problems;
}

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
  custom_fields: 'Extra fields',
};

export const ISSUE_TEXT: Record<string, string> = {
  NO_ROW_ID: 'No value in the ID column',
  NO_NAME: 'No name',
  NO_CONTACT: 'No usable phone or email',
  DUPLICATE_IN_SHEET: 'Same ID as an earlier row',
  DUPLICATE_IN_FILE: 'Same name, phone and email as an earlier row',
};

const HOLD_TEXT: Record<string, string> = {
  DO_NOT_CONTACT: 'do-not-contact',
  NO_DIALABLE_PHONE: 'no phone that can be dialled',
  STATUS_CHANGED: 'status changed meanwhile',
  HUMAN_TAKEOVER: 'handled by a person',
};

const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

export function approveMessage(r: ApproveResult): string {
  if (r.approved === 0) return 'Nothing approved — those rows were already decided.';
  const parts = [`Approved ${plural(r.approved, 'lead')}.`];
  if (r.released > 0) parts.push(`${plural(r.released, 'lead is', 'leads are')} now eligible for your outreach strategy.`);
  if (r.outreach && r.outreach.queued > 0) {
    parts.push(
      r.outreach.mode === 'now'
        ? `${plural(r.outreach.queued, 'lead is', 'leads are')} queued to call now, paced by your call limits.`
        : `${plural(r.outreach.queued, 'lead is', 'leads are')} scheduled for ${startLabel(r.outreach.startAt, r.outreach.timeZone)}.`,
    );
  }
  if (r.held.length > 0) {
    const counts = new Map<string, number>();
    for (const h of r.held) counts.set(h.reason, (counts.get(h.reason) ?? 0) + 1);
    const why = [...counts].map(([reason, n]) => `${n} ${HOLD_TEXT[reason] ?? reason.toLowerCase()}`).join(', ');
    parts.push(`${plural(r.held.length, 'stays', 'stay')} paused (${why}).`);
  }
  if (r.skipped.length > 0) parts.push(`${plural(r.skipped.length, 'row was', 'rows were')} already decided.`);
  return parts.join(' ');
}

export function rejectMessage(r: RejectResult): string {
  if (r.rejected === 0) return 'Nothing rejected — those rows were already decided.';
  return `Rejected ${plural(r.rejected, 'lead')}: closed, and never contacted.${
    r.skipped.length ? ` ${plural(r.skipped.length, 'row was', 'rows were')} already decided.` : ''
  }`;
}

/** A value from a diff, as text a person can compare. */
export function formatValue(v: unknown): string {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v === 'number') return v.toLocaleString('en-US');
  if (typeof v === 'object') {
    const entries = Object.entries(v as Record<string, unknown>);
    return entries.length ? entries.map(([k, x]) => `${k}: ${String(x)}`).join('; ') : '—';
  }
  return String(v);
}

/** A run's skipped-row counts as one line. */
export function skippedLine(skipped: Record<string, number> | undefined): string {
  const entries = Object.entries(skipped ?? {}).filter(([, n]) => n > 0);
  return entries.length ? entries.map(([code, n]) => `${n} ${(ISSUE_TEXT[code] ?? code).toLowerCase()}`).join(', ') : '';
}
