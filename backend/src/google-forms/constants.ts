import { LeadSourceProvider } from '@prisma/client';

/**
 * Vocabulary for Google Forms sources.
 *
 * A leaf module on purpose: the ingest pipeline imports these names, so it
 * must not drag the Google Forms services in with them (the same arrangement
 * custom-webhook/constants.ts has with the processing worker).
 */

/** lead_sources.provider and ingest_events.provider for a Google Forms source. */
export const GOOGLE_FORMS_PROVIDER = LeadSourceProvider.GOOGLE_FORMS;

/** The public path the Apps Script posts to: /ingest/v1/google-forms/:token. */
export const GOOGLE_FORMS_ROUTE = 'google-forms';

/** The header the Apps Script signs each body with: `sha256=<base64 HMAC-SHA256>`. */
export const GOOGLE_FORMS_SIGNATURE_HEADER = 'x-estatepulse-signature';

/** ingest_events.event_type for a response the Apps Script delivered. */
export const GOOGLE_FORMS_EVENT_TYPE = 'google_forms.response';

/** ingest_events.event_type for a response the recovery poller found instead. */
export const GOOGLE_FORMS_RECOVERED_EVENT_TYPE = 'google_forms.recovered';

/**
 * leads.review_reasons when a response was edited in Google Forms after we had
 * already made a lead from it. The lead is NOT overwritten — an owner who has
 * read it would otherwise see it silently change under them — it is flagged and
 * its automation paused, and the new values are on the delivery.
 */
export const RESPONSE_EDITED_REASON = 'The form response was edited after it arrived — check the latest answers';

/**
 * lead_sources.remote_error_code when `forms.get` no longer matches the
 * mapping the owner saved: a question was added, removed, renamed or retyped.
 */
export const SCHEMA_CHANGED_CODE = 'FORM_SCHEMA_CHANGED';

/** How far before the last successful poll the next one re-reads, to cover clock skew. */
export const POLL_OVERLAP_MS = 10 * 60 * 1000;

/** A poll reads at most this many responses per run; the rest wait for the next one. */
export const POLL_PAGE_SIZE = 200;

/** A lease older than this is treated as a crashed worker's and taken over. */
export const LEASE_STUCK_SECONDS = 600;
