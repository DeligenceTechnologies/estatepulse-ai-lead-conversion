import type { CalendarProviderId } from './providers/types';

/**
 * A booking link that already knows which lead it is for.
 *
 * The page is the provider's own — we never create bookings — but the link
 * carries the lead's name and email, so nobody retypes them, and the lead's id
 * in a field the provider hands back with the booking:
 *
 *  - Calendly: `utm_source=estatepulse&utm_content=<leadId>`, returned on the
 *    invitee as `tracking`.
 *  - Cal.com:  `metadata[leadId]=<leadId>`, returned on the booking as `metadata`.
 *
 * The sync then attributes the booking by that id before falling back to
 * matching the attendee's email or phone. Pure; tested in lead-booking-link.spec.ts.
 */

export const LEAD_BOOKING_UTM_SOURCE = 'estatepulse';

export function leadBookingUrl(
  provider: CalendarProviderId,
  schedulingUrl: string,
  lead: { id: string; name: string | null; email: string | null },
): string | null {
  let url: URL;
  try {
    url = new URL(schedulingUrl);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:') return null;

  if (lead.name?.trim()) url.searchParams.set('name', lead.name.trim());
  if (lead.email?.trim()) url.searchParams.set('email', lead.email.trim());

  if (provider === 'calendly') {
    url.searchParams.set('utm_source', LEAD_BOOKING_UTM_SOURCE);
    url.searchParams.set('utm_content', lead.id);
  } else {
    url.searchParams.set('metadata[leadId]', lead.id);
  }
  return url.toString();
}
