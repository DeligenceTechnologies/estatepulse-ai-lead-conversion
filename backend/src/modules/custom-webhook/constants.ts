/**
 * Vocabulary for custom webhook sources. All of it lives in existing varchar
 * columns that carry no CHECK constraint (verified against pg_constraint), so
 * nothing here needs a migration.
 */

/** lead_sources.provider for a custom webhook source. */
export const CUSTOM_PROVIDER = 'CUSTOM';

/** webhook_events.provider / event_type for every custom delivery. */
export const CUSTOM_EVENT_TYPE = 'custom.delivery';

/**
 * webhook_events.outcome_reason while a delivery waits for the owner to map the
 * source. Such rows are PENDING with a far-future available_at, exactly how a
 * paused source holds its backlog, so the worker never sees them.
 */
export const AWAITING_MAPPING = 'awaiting_mapping';

/**
 * outcome_reason once activation releases a held delivery. The worker reads it
 * back and creates the lead paused and flagged for review: a payload captured
 * before anyone had mapped the source is not something to auto-contact.
 */
export const CAPTURED_DURING_SETUP = 'captured_during_setup';

/** leads.review_reasons entry on a lead made from such a delivery. */
export const SETUP_REVIEW_REASON = 'captured_during_setup';

/**
 * How many deliveries a listening source may hold. Past this they are dropped
 * (acknowledged with 2xx so the sender stops retrying) and the source carries a
 * warning, rather than letting a forgotten setup fill the table.
 */
export const HELD_CAP = 500;

/** Mapping rows for a custom source carry the JSON path here (<= 255 chars). */
export const MAX_PATH_CHARS = 255;

/** Prefix on a custom-field answer's key, so no mapping row ever matches it — see extract.ts. */
export const CUSTOM_KEY_PREFIX = '__custom__:';
