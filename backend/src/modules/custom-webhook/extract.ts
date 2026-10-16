import type { NormalizedAnswer, NormalizedDelivery } from '../ingest/adapters/types';
import { CUSTOM_TARGET, PHONE_UNPARSED_REASON } from '../google-sheets/sheet-rows';
import { CANONICAL_FIELDS } from '../processing/canonical-fields';
import { IGNORE_TARGET } from '../processing/canonical-fields';
import { applyTransform, isValidEmail, type Transform } from '../processing/transforms';
import { validateCanonicalValues, type CanonicalValue } from '../processing/validators';
import { CUSTOM_EVENT_TYPE, CUSTOM_KEY_PREFIX } from './constants';
import { valueAt } from './flatten';
import type { StoredMapping } from './mapping';

/**
 * A custom delivery as the worker's mapping engine expects it.
 *
 * For a form provider the adapter knows the questions; here the owner's mapping
 * IS the list of questions, so this reads exactly the paths that are mapped
 * (nothing else: a CRM payload has dozens of leaves nobody asked for, and the
 * whole payload is on the webhook_events row anyway).
 *
 * A canonical path becomes an answer keyed by its path, which the mapping rows
 * then match. A custom-field path becomes an answer keyed `__custom__:<path>`
 * — no mapping row carries that key, so the engine files it under its label
 * as an extra field, which is precisely what the owner asked for.
 */

const typeLabel = (t: string): string => t.toUpperCase();

export function extractDelivery(payload: unknown, mappings: StoredMapping[]): NormalizedDelivery {
  const answers: NormalizedAnswer[] = [];
  const seen = new Set<string>();

  for (const m of mappings) {
    if (m.target_field === IGNORE_TARGET) continue;
    const custom = m.target_field === CUSTOM_TARGET;
    const key = custom ? `${CUSTOM_KEY_PREFIX}${m.source_field_key}` : m.source_field_key;
    if (seen.has(key)) continue;
    seen.add(key);

    let read: ReturnType<typeof valueAt>;
    try {
      read = valueAt(payload, m.source_field_key);
    } catch {
      read = { value: '', type: 'null', present: false };
    }
    const value = read.value;
    answers.push({
      key,
      label: custom ? (m.transform.label ?? m.source_field_key) : m.source_field_key,
      type: typeLabel(read.type),
      raw: value,
      textValues: value ? [value] : [],
      scalarText: value,
    });
  }

  return {
    providerEventId: null,
    providerSubmissionId: null,
    providerRespondentId: null,
    providerFormId: null,
    providerFormName: null,
    eventType: CUSTOM_EVENT_TYPE,
    submittedAt: null,
    answers,
    fields: answers.map((a) => ({ key: a.key, label: a.label, type: a.type })),
    warnings: [],
  };
}

export interface LeadPreview {
  /** False when the payload carries neither a phone nor an email under the mapping. */
  wouldCreate: boolean;
  /** The status the lead would start in, when one would be created. */
  status: 'new' | 'invalid' | null;
  values: Record<string, CanonicalValue>;
  customFields: Record<string, string>;
  warnings: string[];
  reviewReasons: string[];
  trace: { path: string; target: string; value: CanonicalValue; warning?: string }[];
}

/**
 * What the worker would make of a payload under a mapping — the same
 * transforms, the same validation, the same identity rule — without writing
 * anything. Drives the mapper's live preview and the "re-run on last payload"
 * button.
 */
export function previewLead(payload: unknown, mappings: StoredMapping[], region: string): LeadPreview {
  const delivery = extractDelivery(payload, mappings);
  const values: Record<string, CanonicalValue> = {};
  const customFields: Record<string, string> = {};
  const warnings: string[] = [];
  const trace: LeadPreview['trace'] = [];

  const byKey = new Map<string, StoredMapping[]>();
  for (const m of mappings) {
    if (m.target_field === CUSTOM_TARGET || m.target_field === IGNORE_TARGET) continue;
    byKey.set(m.source_field_key, [...(byKey.get(m.source_field_key) ?? []), m]);
  }

  for (const a of delivery.answers) {
    const targets = byKey.get(a.key);
    if (!targets) {
      if (a.scalarText) customFields[a.label] = a.scalarText;
      continue;
    }
    for (const m of targets) {
      try {
        const { value, warning } = applyTransform(m.transform as Transform, a.textValues, a.scalarText, region);
        if (value !== null && value !== '') values[m.target_field] = value;
        if (warning) warnings.push(`${a.label}: ${warning}`);
        trace.push({ path: a.key, target: m.target_field, value, ...(warning ? { warning } : {}) });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        warnings.push(`${a.label}: ${msg}`);
        trace.push({ path: a.key, target: m.target_field, value: null, warning: msg });
      }
    }
  }

  const validated = validateCanonicalValues(values);
  for (const r of validated.rejected) {
    const label = CANONICAL_FIELDS[r.field]?.label ?? r.field;
    if (r.raw) customFields[`${label} (unvalidated)`] = r.raw;
  }
  warnings.push(...validated.warnings);

  const phone = typeof validated.values.phone === 'string' ? validated.values.phone : null;
  const email = typeof validated.values.email === 'string' ? validated.values.email : null;
  const reviewReasons = [...validated.warnings];
  if (phone && !phone.startsWith('+')) reviewReasons.push(PHONE_UNPARSED_REASON);

  const wouldCreate = Boolean(phone || email);
  const status = !wouldCreate ? null : (phone && phone.startsWith('+')) || (email && isValidEmail(email)) ? 'new' : 'invalid';

  return { wouldCreate, status, values: validated.values, customFields, warnings, reviewReasons, trace };
}
