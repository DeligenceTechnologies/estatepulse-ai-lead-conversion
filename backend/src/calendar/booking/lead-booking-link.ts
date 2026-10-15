import type { CalendarProvider } from '@prisma/client';

export const LEAD_BOOKING_UTM_SOURCE = 'estatepulse';

/**
 * An event type's booking page with the lead's name and email filled in and
 * the lead's id attached, so the meeting it produces is matched back to the
 * lead: Calendly returns utm_content on the invitee, Cal.com the metadata.
 */
export function leadBookingUrl(
  provider: CalendarProvider,
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
