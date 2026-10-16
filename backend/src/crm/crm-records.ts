import { createHash } from 'node:crypto';
import { CANONICAL_FIELDS } from '@/ingest/processing/canonical-fields';
import { applyTransform, isValidEmail } from '@/ingest/processing/transforms';
import { validateCanonicalValues, type CanonicalValue } from '@/ingest/processing/validators';
import { PHONE_UNPARSED_REASON, type BuiltRow, type LeadFields } from '@/google-sheets/sheet-rows';

/**
 * Pure CRM logic shared by every provider: the field ownership policy, and
 * turning one CRM contact into what the import engine writes. No database, no
 * HTTP — a provider adapter hands over a `CrmContact` and nothing here knows
 * which CRM it came from beyond its display name.
 *
 * Normalisation is the SAME code the form and sheet pipelines use
 * (applyTransform, validateCanonicalValues, isValidEmail), so a phone or email
 * reads identically whichever way a lead arrived — which is what makes the
 * duplicate checks across sources meaningful.
 */

// ---------------------------------------------------------------------------
// Field ownership — the synchronisation policy, in one place
// ---------------------------------------------------------------------------

/**
 * Lead columns a CRM contact fills. These are the CRM's: inbound sync may set
 * them, and an EstatePulse lead never pushes them back (see CRM_OUTBOUND_FIELDS).
 * Each also has derived columns (normalized_email, email_valid,
 * normalized_phone, phone_valid) computed from it, never read from the CRM.
 *
 * Plus the CRM's own namespaced extras in custom_fields — every key that starts
 * with the provider's prefix ("HubSpot ") belongs to the CRM, and no other key
 * is ever touched.
 */
export const CRM_INBOUND_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const;

/**
 * Lead columns that are EstatePulse's alone. A CRM never writes these, however
 * its records change — not on insert beyond the safe defaults the import
 * engine sets, not on refresh, not on "apply change". Listed so the policy is
 * reviewable, and pinned by crm-records.spec.ts.
 *
 * Deliberately here: `location`. A CRM contact's address is where the person
 * LIVES; a lead's location is where they want to BUY, and the routing engine
 * matches it against agent territories. Copying one into the other would route
 * leads on the wrong fact.
 */
export const ESTATEPULSE_OWNED_FIELDS = [
  'status',
  'follow_up_reason',
  'temperature',
  'score',
  'dnc_status',
  'consent_status',
  'automation_paused',
  'takeover_user_id',
  'location',
  'min_budget',
  'max_budget',
  'bedrooms',
  'motivation',
  'timeline',
  'buying_intent',
  'financing_status',
  'ai_summary',
  'extracted_intel',
  'lost_reason',
] as const;

/**
 * EstatePulse -> CRM: nothing, yet. Write-back needs a product decision this
 * codebase does not have — which EstatePulse value lands in which CRM property
 * (our lead statuses and temperature have no standard HubSpot counterpart) —
 * and EstatePulse has no screen that edits a lead's contact fields, so there is
 * no user change to send. Inbound sync is therefore the whole of the sync, and
 * no sync loop can form: nothing written here is ever echoed back.
 */
export const CRM_OUTBOUND_FIELDS = [] as const;

// ---------------------------------------------------------------------------
// The contact as an adapter hands it over
// ---------------------------------------------------------------------------

export type CrmObjectType = 'contact';

export interface CrmContact {
  /** The provider's record id. Never reused for another record by the provider. */
  externalId: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  /** The adapter's choice of primary number (HubSpot: phone, else mobilephone). */
  phone: string | null;
  /**
   * Provider values shown on the lead but never mapped onto a core column —
   * lifecycle stage, the CRM's own lead status. Keyed by the label shown to a
   * person, which must start with the provider's custom-field prefix.
   */
  extra: Record<string, string | null>;
}

export interface CrmProviderLabel {
  /** "HubSpot" — used in review reasons and messages. */
  displayName: string;
  /** "HubSpot " — every custom_fields key this provider owns starts with it. */
  customPrefix: string;
}

export const crmImportReviewReason = (p: CrmProviderLabel): string => `Imported from ${p.displayName} — awaiting owner approval`;
/** Every "no name" reason starts with this, whichever CRM raised it. */
export const NO_NAME_REASON_PREFIX = 'No name in ';
export const crmNoNameReason = (p: CrmProviderLabel): string => `${NO_NAME_REASON_PREFIX}${p.displayName} — check who this is before contacting them`;

/** lead_sources.provider / provider_credentials.provider for each CRM. */
export const HUBSPOT_PROVIDER = 'HUBSPOT';

/**
 * Every CRM this build knows, by provider code. Adding a CRM adds a line here
 * and an adapter; nothing in the import engine or the review queue changes.
 */
export const CRM_PROVIDER_LABELS: Record<string, CrmProviderLabel> = {
  [HUBSPOT_PROVIDER]: { displayName: 'HubSpot', customPrefix: 'HubSpot ' },
};

/** The import reason each CRM's new leads start with; approval and rejection spend whichever one a lead carries. */
export const CRM_IMPORT_REVIEW_REASONS = Object.values(CRM_PROVIDER_LABELS).map(crmImportReviewReason);

/** Contacts have no row number. The tracking table requires one (>= 1); it is display-only and never compared. */
export const CRM_ROW_NUMBER = 1;

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** Stable JSON: keys sorted, so equal content always hashes equal. */
function stable(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stable).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stable(obj[k])}`)
    .join(',')}}`;
}

/**
 * The tracking key for one CRM record: (provider, object type, record id),
 * hashed to the tracking table's fixed width. Unique per lead source in the
 * database, so a record can be imported at most once per connection however
 * runs, retries and webhooks interleave.
 */
export function crmRowKey(provider: string, objectType: CrmObjectType, externalId: string): string {
  return sha256(`crm\u0000${provider}\u0000${objectType}\u0000${externalId}`);
}

/** Blank, whitespace-only and absent are one thing: no value. */
export function clean(v: string | null | undefined, maxLen: number): string | null {
  if (v === null || v === undefined) return null;
  const t = String(v).trim();
  return t ? t.slice(0, maxLen) : null;
}

/** The provider's keys only, so a lead's other custom fields are never part of the CRM's state. */
function crmCustom(custom: unknown, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (!custom || typeof custom !== 'object' || Array.isArray(custom)) return out;
  for (const [k, v] of Object.entries(custom as Record<string, unknown>)) {
    if (k.startsWith(prefix) && typeof v === 'string' && v) out[k] = v;
  }
  return out;
}

/**
 * A hash of exactly the CRM-owned state of a lead: the four contact columns as
 * stored, and the provider's custom fields.
 *
 * Computable from BOTH sides — the incoming contact and the lead row as it is
 * now — which is what makes a three-way comparison possible without storing
 * the last synced values: when the lead still hashes to what was last synced,
 * nothing on the EstatePulse side has touched the CRM's fields, and a new CRM
 * value can be applied without overwriting anybody's edit.
 */
export function crmOwnedHash(
  lead: { first_name: string | null; last_name: string | null; email: string | null; phone: string | null; custom_fields: unknown },
  prefix: string,
): string {
  return sha256(
    stable({
      first_name: lead.first_name ?? null,
      last_name: lead.last_name ?? null,
      email: lead.email ?? null,
      phone: lead.phone ?? null,
      custom: crmCustom(lead.custom_fields, prefix),
    }),
  );
}

/**
 * A lead's custom fields with the provider's keys replaced by `incoming`'s.
 * Every other key — a form answer, a sheet column — is kept as it is.
 */
export function mergeCrmCustom(existing: unknown, incoming: Record<string, string>, prefix: string): Record<string, string> {
  const out: Record<string, string> = {};
  if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
    for (const [k, v] of Object.entries(existing as Record<string, unknown>)) {
      if (!k.startsWith(prefix) && typeof v === 'string') out[k] = v;
    }
  }
  return { ...out, ...crmCustom(incoming, prefix) };
}

// ---------------------------------------------------------------------------
// The field-level three-way merge
// ---------------------------------------------------------------------------

/** The CRM-owned state of a lead, as stored in sheet_import_rows.synced_values. */
export interface CrmValues {
  first_name: string | null;
  last_name: string | null;
  email: string | null;
  phone: string | null;
  /** The provider's custom fields only. */
  custom: Record<string, string>;
}

export const CRM_CORE_FIELDS = ['first_name', 'last_name', 'email', 'phone'] as const;
type CoreField = (typeof CRM_CORE_FIELDS)[number];

/**
 * The phone is compared as its E.164 form where it has one — normalised by the
 * same pipeline, in the same region, on both sides — so "(512) 555-0101" and
 * "+15125550101" are one number. An unparseable number compares as typed.
 */
export function crmValuesOf(
  lead: {
    first_name: string | null;
    last_name: string | null;
    email: string | null;
    phone: string | null;
    normalized_phone?: string | null;
    custom_fields: unknown;
  },
  prefix: string,
): CrmValues {
  return {
    first_name: lead.first_name ?? null,
    last_name: lead.last_name ?? null,
    email: lead.email ?? null,
    phone: lead.normalized_phone ?? lead.phone ?? null,
    custom: crmCustom(lead.custom_fields, prefix),
  };
}

/** Same value for the purpose of "did it change": an email by case, a phone by its digits, a name by spacing. */
function same(field: CoreField, a: string | null, b: string | null): boolean {
  const empty = (v: string | null) => v === null || !v.trim();
  if (empty(a) || empty(b)) return empty(a) && empty(b);
  if (field === 'email') return a!.trim().toLowerCase() === b!.trim().toLowerCase();
  if (field === 'phone') return a!.replace(/\D/g, '') === b!.replace(/\D/g, '');
  return a!.trim().replace(/\s+/g, ' ') === b!.trim().replace(/\s+/g, ' ');
}

export interface CrmMergeResult {
  /** Fields to take from the CRM. */
  apply: CoreField[];
  /** Fields changed on both sides, to different values: the owner decides. */
  conflicts: CoreField[];
}

/**
 * Per field, with `base` = what the CRM said last time (null for a record just
 * linked to a lead that already existed):
 *
 *  - the CRM did not change it                     -> nothing to do
 *  - the CRM's value is empty                      -> nothing to do: an empty
 *    value never clears one (a CRM read cannot tell "cleared" from "absent")
 *  - both sides already agree                      -> nothing to do
 *  - the lead has no value                         -> take the CRM's (a fill)
 *  - only the CRM changed it (lead still == base)  -> take the CRM's
 *  - both changed it, differently                  -> conflict
 *
 * The CRM's own custom fields (lifecycle stage, its lead status) are a mirror
 * of the CRM, never edited here, so they always follow it and never conflict.
 */
export function crmMerge(base: CrmValues | null, ours: CrmValues, theirs: CrmValues): CrmMergeResult {
  const apply: CoreField[] = [];
  const conflicts: CoreField[] = [];
  for (const f of CRM_CORE_FIELDS) {
    const t = theirs[f];
    if (base && same(f, t, base[f])) continue;
    if (t === null || !t.trim()) continue;
    if (same(f, ours[f], t)) continue;
    if (ours[f] === null || !ours[f]!.trim()) apply.push(f);
    else if (base && same(f, ours[f], base[f])) apply.push(f);
    else conflicts.push(f);
  }
  return { apply, conflicts };
}

const str = (v: CanonicalValue | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

/**
 * One CRM contact -> the row the import engine writes, or why not.
 *
 * Refused only when there is no way to reach the person: neither a dialable
 * phone nor a valid email. A missing name is imported with a review reason —
 * CRMs hold plenty of email-only contacts, and refusing them would silently
 * drop real leads. Nothing is ever invented: an absent email stays absent.
 *
 * `key` is set even on a refusal, so a contact that is still in the CRM is
 * never mistaken for one that was deleted.
 */
export function buildCrmRow(provider: string, label: CrmProviderLabel, contact: CrmContact, region: string): BuiltRow {
  const key = crmRowKey(provider, 'contact', contact.externalId);
  const values: Record<string, CanonicalValue> = {};
  const custom: Record<string, string> = {};
  const warnings: string[] = [];

  const put = (target: string, raw: string | null, transform: Parameters<typeof applyTransform>[0]) => {
    if (!raw) return;
    const { value, warning } = applyTransform(transform, [raw], raw, region);
    if (value !== null && value !== '') values[target] = value;
    if (warning) warnings.push(`${CANONICAL_FIELDS[target]?.label ?? target}: ${warning}`);
  };
  put('first_name', clean(contact.firstName, 100), { kind: 'text', maxLen: 100 });
  put('last_name', clean(contact.lastName, 100), { kind: 'text', maxLen: 100 });
  put('email', clean(contact.email, 255), { kind: 'email' });
  put('phone', clean(contact.phone, 50), { kind: 'phone_e164', defaultRegion: region });

  for (const [k, v] of Object.entries(contact.extra)) {
    const value = clean(v, 500);
    if (value && k.startsWith(label.customPrefix)) custom[k] = value;
  }

  // Same last gate as the form pipeline: a value a column cannot hold is kept,
  // readable, rather than dropped.
  const validated = validateCanonicalValues(values);
  for (const r of validated.rejected) {
    if (r.raw) custom[`${label.customPrefix}${CANONICAL_FIELDS[r.field]?.label ?? r.field} (unvalidated)`] = r.raw.slice(0, 500);
  }
  warnings.push(...validated.warnings);
  const v = validated.values;

  const phone = str(v.phone);
  const normalizedPhone = phone && phone.startsWith('+') ? phone : null;
  const email = str(v.email);
  const emailValid = email ? isValidEmail(email) : false;
  const normalizedEmail = emailValid ? email!.toLowerCase() : null;
  const firstName = str(v.first_name);
  const lastName = str(v.last_name);

  if (!normalizedPhone && !emailValid) {
    return { rowNumber: CRM_ROW_NUMBER, blank: false, issue: 'NO_CONTACT', key, externalId: contact.externalId, reviewReasons: [] };
  }

  const lead: LeadFields = {
    first_name: firstName,
    last_name: lastName,
    email,
    normalized_email: normalizedEmail,
    email_valid: emailValid,
    phone,
    normalized_phone: normalizedPhone,
    phone_valid: Boolean(normalizedPhone),
    // EstatePulse's — see ESTATEPULSE_OWNED_FIELDS. Never filled from a CRM.
    location: null,
    min_budget: null,
    max_budget: null,
    bedrooms: null,
    motivation: null,
    custom_fields: custom,
  };

  const reviewReasons = [...warnings];
  if (phone && !normalizedPhone) reviewReasons.push(PHONE_UNPARSED_REASON);
  if (!firstName && !lastName) reviewReasons.push(crmNoNameReason(label));

  return {
    rowNumber: CRM_ROW_NUMBER,
    blank: false,
    key,
    hash: crmOwnedHash(lead, label.customPrefix),
    lead,
    externalId: contact.externalId,
    reviewReasons,
    crmPrefix: label.customPrefix,
  };
}
