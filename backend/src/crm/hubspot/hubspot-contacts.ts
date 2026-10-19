import type { CrmContact } from '../crm-records';

/**
 * HubSpot contact properties -> the provider-neutral CrmContact. Pure.
 *
 * Only what EstatePulse has a place for is read: names, email, a phone, and two
 * HubSpot fields shown on the lead for context. Not mapped, deliberately:
 *  - lifecyclestage / hs_lead_status onto the lead's status — different
 *    vocabularies with different meanings (a HubSpot "customer" is not an
 *    EstatePulse "closed"); they are shown, namespaced, in custom fields.
 *  - address/city/state onto location — where someone lives is not where they
 *    want to buy, and location drives agent routing.
 *  - hubspot_owner_id — an id that means nothing without HubSpot's owner list
 *    (another scope), and EstatePulse assigns its own agents.
 *  - createdate / lastmodifieddate — HubSpot's clock, not a lead fact; the
 *    modified date drives incremental sync and the created date only tells a
 *    contact made after the connection (auto-approval). Neither reaches the
 *    lead, or every unrelated HubSpot edit would read as a change.
 */

/** Requested on every read, so a contact always arrives with the same shape. */
export const HUBSPOT_CONTACT_PROPERTIES = [
  'firstname',
  'lastname',
  'email',
  'phone',
  'mobilephone',
  'lifecyclestage',
  'hs_lead_status',
  'createdate',
  'lastmodifieddate',
] as const;

export const LIFECYCLE_LABEL = 'HubSpot lifecycle stage';
export const LEAD_STATUS_LABEL = 'HubSpot lead status';

/** HubSpot's default internal values -> the labels HubSpot shows. Custom values pass through. */
const LIFECYCLE_STAGES: Record<string, string> = {
  subscriber: 'Subscriber',
  lead: 'Lead',
  marketingqualifiedlead: 'Marketing Qualified Lead',
  salesqualifiedlead: 'Sales Qualified Lead',
  opportunity: 'Opportunity',
  customer: 'Customer',
  evangelist: 'Evangelist',
  other: 'Other',
};

const LEAD_STATUSES: Record<string, string> = {
  NEW: 'New',
  OPEN: 'Open',
  IN_PROGRESS: 'In Progress',
  OPEN_DEAL: 'Open Deal',
  UNQUALIFIED: 'Unqualified',
  ATTEMPTED_TO_CONTACT: 'Attempted to Contact',
  CONNECTED: 'Connected',
  BAD_TIMING: 'Bad Timing',
};

export interface HubSpotObject {
  id: string;
  properties?: Record<string, string | null | undefined>;
  updatedAt?: string;
  archived?: boolean;
}

const text = (v: string | null | undefined): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

export function toCrmContact(o: HubSpotObject): CrmContact {
  const p = o.properties ?? {};
  const stage = text(p.lifecyclestage);
  const status = text(p.hs_lead_status);
  return {
    externalId: String(o.id),
    firstName: text(p.firstname),
    lastName: text(p.lastname),
    email: text(p.email),
    // The main number when there is one; a mobile is a fine second choice — it
    // is the person's own line either way.
    phone: text(p.phone) ?? text(p.mobilephone),
    extra: {
      [LIFECYCLE_LABEL]: stage ? (LIFECYCLE_STAGES[stage] ?? stage) : null,
      [LEAD_STATUS_LABEL]: status ? (LEAD_STATUSES[status] ?? status) : null,
    },
    createdAt: epochMs(p.createdate) || null,
  };
}

/** HubSpot's last-modified time for a contact, in epoch ms; 0 when absent or unreadable. */
export function modifiedAtMs(o: HubSpotObject): number {
  return epochMs(o.properties?.lastmodifieddate ?? o.updatedAt);
}

/** A HubSpot timestamp (epoch-ms digits or an ISO date) in epoch ms; 0 when absent or unreadable. */
function epochMs(raw: string | null | undefined): number {
  if (!raw) return 0;
  const asNumber = Number(raw);
  const ms = Number.isFinite(asNumber) && /^\d+$/.test(raw) ? asNumber : Date.parse(raw);
  return Number.isFinite(ms) ? ms : 0;
}
