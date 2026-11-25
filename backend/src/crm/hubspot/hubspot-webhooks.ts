import { createHash } from 'node:crypto';
import { z } from 'zod';

/**
 * HubSpot webhook deliveries: event parsing. Pure — nothing here touches the
 * database. HubSpot signs its deliveries with the app's client secret, which
 * only Nango holds: Nango checks that signature and forwards the body to
 * /webhooks/nango, signed with Nango's key (see NangoWebhookService).
 */

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

const id = z.union([z.number().int().nonnegative(), z.string().regex(/^\d{1,20}$/)]).transform((v) => String(v));

/**
 * One event as HubSpot sends it. Unknown fields are dropped; only identifiers
 * survive parsing. `propertyValue` is deliberately NOT read: it can carry the
 * new email or phone, and every event is handled by re-reading the contact, so
 * keeping the value would store personal data for no purpose.
 */
const eventSchema = z.object({
  eventId: id,
  subscriptionId: id.optional(),
  portalId: id,
  appId: id.optional(),
  occurredAt: z.number().int().nonnegative(),
  // The field table and signature samples say subscriptionType; one example
  // says eventType. Either is accepted.
  subscriptionType: z.string().max(100).optional(),
  eventType: z.string().max(100).optional(),
  attemptNumber: z.number().int().nonnegative().optional(),
  objectId: id.optional(),
  objectTypeId: z.string().max(20).optional(),
  propertyName: z.string().max(200).optional(),
  changeSource: z.string().max(100).optional(),
  primaryObjectId: id.optional(),
  mergedObjectIds: z.array(id).max(200).optional(),
  newObjectId: id.optional(),
});

/** HubSpot sends at most 100 events per request; the bound is generous and still bounds the work. */
export const deliverySchema = z.array(eventSchema).min(1).max(500);

export interface HubSpotEvent {
  dedupeKey: string;
  portalId: string;
  eventId: string;
  type: string;
  occurredAt: number;
  /** Every contact this event says may have changed. Empty for an event we do not act on. */
  contactIds: string[];
  /** What is stored: identifiers and the event's shape, no values. */
  stored: Record<string, unknown>;
}

/** Contact events we act on. associationChange is not: EstatePulse imports no associations. */
const CONTACT_TYPES = new Set([
  'contact.creation',
  'contact.deletion',
  'contact.propertyChange',
  'contact.merge',
  'contact.restore',
  'contact.privacyDeletion',
]);
/** The generic forms, for contacts only (objectTypeId 0-1). */
const GENERIC_TYPES = new Set(['object.creation', 'object.deletion', 'object.propertyChange', 'object.merge', 'object.restore']);
const CONTACT_OBJECT_TYPE = '0-1';

/**
 * HubSpot documents that eventId "is not guaranteed to be unique", so the
 * deduplication key is built from every identifying field of the event:
 * account, subscription, event id, time, type, object and property. A retry of
 * the same event (attemptNumber moves) maps to the same key; two different
 * events would have to agree on all seven to collide. And a collision is
 * harmless anyway: every event is processed by re-reading the contact.
 */
export function dedupeKeyFor(e: z.infer<typeof eventSchema>, type: string): string {
  const parts = [e.portalId, e.subscriptionId ?? '', e.eventId, e.occurredAt, type, e.objectId ?? '', e.propertyName ?? ''];
  return `hs:${createHash('sha256').update(parts.join('\u0000')).digest('hex')}`;
}

export function parseDelivery(body: unknown): { events: HubSpotEvent[] } | { error: string } {
  const parsed = deliverySchema.safeParse(body);
  if (!parsed.success) return { error: parsed.error.issues[0]?.message ?? 'Not a HubSpot webhook delivery' };
  return {
    events: parsed.data.map((e) => {
      const type = e.subscriptionType ?? e.eventType ?? 'unknown';
      // A generic event names its object type; without one it is not known to be a contact.
      const contact = CONTACT_TYPES.has(type) || (GENERIC_TYPES.has(type) && e.objectTypeId === CONTACT_OBJECT_TYPE);
      const ids = contact
        ? [e.objectId, e.primaryObjectId, e.newObjectId, ...(e.mergedObjectIds ?? [])].filter((x): x is string => Boolean(x))
        : [];
      return {
        dedupeKey: dedupeKeyFor(e, type),
        portalId: e.portalId,
        eventId: e.eventId,
        type,
        occurredAt: e.occurredAt,
        contactIds: [...new Set(ids)],
        stored: {
          eventId: e.eventId,
          subscriptionId: e.subscriptionId ?? null,
          type,
          occurredAt: e.occurredAt,
          attemptNumber: e.attemptNumber ?? null,
          objectId: e.objectId ?? null,
          objectTypeId: e.objectTypeId ?? null,
          propertyName: e.propertyName ?? null,
          changeSource: e.changeSource ?? null,
          contactIds: [...new Set(ids)],
        },
      };
    }),
  };
}
