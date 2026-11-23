import type { CreatableType } from './airtable-fields';
import { kindOf, type ValueKind } from './airtable-records';

/**
 * What EstatePulse can send back to Airtable about a lead it has worked.
 *
 * The inbound mapping answers "which Airtable column fills which lead field".
 * This answers the opposite, and it is deliberately a SEPARATE list: a lead's
 * score, its call outcome and whether it is do-not-contact are things
 * EstatePulse works out. Letting somebody set them by typing in a spreadsheet
 * would make the number meaningless, so nothing here is ever read back.
 *
 * Which of these actually travel is the owner's choice, stored per source in
 * lead_sources.sync_config. The catalogue is fixed because each entry needs a
 * reader and an Airtable column type; the selection is not.
 */

export interface WriteBackField {
  /** Stored in sync_config and used as the outbound mapping's target. Never renamed. */
  key: string;
  label: string;
  /** What the owner reads under the label when choosing. */
  help: string;
  /** The column EstatePulse creates for this, when asked to create one. */
  type: CreatableType;
  /** Offered for a select. Airtable typecast adds anything missing anyway, so these are a starting point, not a limit. */
  choices?: string[];
  /** Grouping in the picker, nothing more. */
  group: 'Progress' | 'What the AI learned' | 'Contact activity' | 'Last call' | 'State';
}

const LEAD_STATUS = [
  'new',
  'contacting',
  'engaged',
  'follow_up',
  'interested',
  'appointment_requested',
  'appointment_booked',
  'not_interested',
  'unresponsive',
  'closed',
  'invalid',
];
const DISPOSITIONS = ['no_answer', 'busy', 'rejected', 'voicemail', 'short', 'connected', 'failed', 'invalid_number'];

export const WRITE_BACK_FIELDS: WriteBackField[] = [
  // ── Progress ──────────────────────────────────────────────────────────────
  { key: 'ep_status', label: 'Lead status', help: 'Where the lead has reached: contacting, engaged, appointment booked, closed.', type: 'singleSelect', choices: LEAD_STATUS, group: 'Progress' },
  { key: 'ep_temperature', label: 'Temperature', help: 'Hot, warm or cold, as the AI reads the conversation.', type: 'singleSelect', choices: ['hot', 'warm', 'cold'], group: 'Progress' },
  { key: 'ep_score', label: 'Lead score', help: 'The qualification score, 0-100.', type: 'number', group: 'Progress' },
  { key: 'ep_buying_intent', label: 'Buying intent', help: 'What the lead said they are trying to do.', type: 'singleLineText', group: 'Progress' },
  { key: 'ep_timeline', label: 'Timeline', help: 'When they want to move.', type: 'singleLineText', group: 'Progress' },
  { key: 'ep_financing_status', label: 'Financing status', help: 'Pre-approved, cash, still arranging, and so on.', type: 'singleLineText', group: 'Progress' },
  { key: 'ep_follow_up_reason', label: 'Follow-up reason', help: 'Why the lead is waiting for another attempt.', type: 'singleSelect', choices: ['no_answer', 'not_ready', 'callback_requested', 'needs_time', 'other', 'appointment_canceled', 'no_show'], group: 'Progress' },
  { key: 'ep_lost_reason', label: 'Lost reason', help: 'Why the lead was closed without a deal.', type: 'singleLineText', group: 'Progress' },

  // ── What the AI learned ───────────────────────────────────────────────────
  { key: 'ep_ai_summary', label: 'AI summary', help: 'The AI’s summary of where this lead stands.', type: 'multilineText', group: 'What the AI learned' },
  { key: 'ep_memory_summary', label: 'What the lead told us', help: 'Things said across calls and texts that no question covers. Rewritten after each conversation.', type: 'multilineText', group: 'What the AI learned' },

  // ── Contact activity ──────────────────────────────────────────────────────
  { key: 'ep_calls_made', label: 'Calls made', help: 'How many calls have been placed to this lead.', type: 'number', group: 'Contact activity' },
  { key: 'ep_first_contact_at', label: 'First contacted', help: 'When EstatePulse first reached out.', type: 'dateTime', group: 'Contact activity' },
  { key: 'ep_first_response_at', label: 'First replied', help: 'When the lead first answered or replied.', type: 'dateTime', group: 'Contact activity' },
  { key: 'ep_last_contact_at', label: 'Last contacted', help: 'The most recent call or message either way.', type: 'dateTime', group: 'Contact activity' },
  { key: 'ep_callback_at', label: 'Callback due', help: 'When the lead asked to be called back. Nothing else contacts them before it.', type: 'dateTime', group: 'Contact activity' },
  { key: 'ep_text_back_at', label: 'Text due', help: 'When the lead asked to be texted.', type: 'dateTime', group: 'Contact activity' },

  // ── Last call ─────────────────────────────────────────────────────────────
  { key: 'ep_last_call_at', label: 'Last call', help: 'When the most recent call ended.', type: 'dateTime', group: 'Last call' },
  { key: 'ep_last_call_disposition', label: 'Last call outcome', help: 'Connected, voicemail, no answer, and so on.', type: 'singleSelect', choices: DISPOSITIONS, group: 'Last call' },
  { key: 'ep_last_call_seconds', label: 'Last call length (seconds)', help: 'How long the most recent call lasted.', type: 'number', group: 'Last call' },
  { key: 'ep_last_call_summary', label: 'Last call summary', help: 'The AI’s summary of the most recent call.', type: 'multilineText', group: 'Last call' },
  { key: 'ep_last_call_recording', label: 'Last call recording', help: 'A link to the recording of the most recent call.', type: 'url', group: 'Last call' },
  {
    key: 'ep_last_call_transcript',
    label: 'Last call transcript',
    help: 'The full transcript. Often thousands of characters — useful to search, heavy to carry in every row. The summary above is usually enough.',
    type: 'multilineText',
    group: 'Last call',
  },

  // ── State ─────────────────────────────────────────────────────────────────
  { key: 'ep_do_not_contact', label: 'Do not contact', help: 'Ticked when this person asked not to be contacted. EstatePulse will not call or text them.', type: 'checkbox', group: 'State' },
  { key: 'ep_needs_review', label: 'Needs review', help: 'Ticked while something about this lead is waiting for a person.', type: 'checkbox', group: 'State' },
  { key: 'ep_automation_paused', label: 'Outreach paused', help: 'Ticked while automated calls and texts are held for this lead.', type: 'checkbox', group: 'State' },
  { key: 'ep_consent_status', label: 'Consent', help: 'Granted, revoked or pending.', type: 'singleSelect', choices: ['granted', 'revoked', 'pending'], group: 'State' },
  { key: 'ep_assigned_to', label: 'Assigned to', help: 'The agent this lead belongs to.', type: 'singleLineText', group: 'State' },
  {
    key: 'ep_link',
    label: 'Open in EstatePulse',
    help: 'A link straight to this lead, so a row in Airtable is one click from the whole conversation.',
    type: 'url',
    group: 'State',
  },
];

/**
 * The catalogue as the picker needs it: each entry carrying the SHAPE it writes,
 * so a column can be offered only where the value would actually fit.
 *
 * Offering every column for every field is what makes the picker unreadable —
 * a score has no business being written into a name, and a date none being
 * written into a checkbox.
 */
export const writeBackCatalogue = (): (WriteBackField & { kind: ValueKind })[] =>
  WRITE_BACK_FIELDS.map((f) => ({ ...f, kind: kindOf(f.type) }));

export const WRITE_BACK_BY_KEY = new Map(WRITE_BACK_FIELDS.map((f) => [f.key, f]));
export const isWriteBackKey = (key: string): boolean => WRITE_BACK_BY_KEY.has(key);

/** One chosen field: what EstatePulse sends, and the Airtable column it lands in. */
export interface WriteBackChoice {
  key: string;
  /** Airtable field id (`fld…`). */
  fieldId: string;
}

export function readWriteBack(value: unknown): WriteBackChoice[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: WriteBackChoice[] = [];
  for (const raw of value) {
    const c = raw as Partial<WriteBackChoice> | null;
    if (!c || typeof c.key !== 'string' || typeof c.fieldId !== 'string') continue;
    // One column holds one thing, and one thing goes to one column.
    if (!isWriteBackKey(c.key) || seen.has(c.key) || seen.has(c.fieldId)) continue;
    seen.add(c.key);
    seen.add(c.fieldId);
    out.push({ key: c.key, fieldId: c.fieldId });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reading the values off a lead
// ---------------------------------------------------------------------------

/** Everything the catalogue above can read. Assembled by the sync's push query. */
export interface WriteBackSource {
  status: string | null;
  temperature: string | null;
  score: number | null;
  buyingIntent: string | null;
  timeline: string | null;
  financingStatus: string | null;
  followUpReason: string | null;
  lostReason: string | null;
  aiSummary: string | null;
  memorySummary: string | null;
  callsMade: number;
  firstContactAt: Date | null;
  firstResponseAt: Date | null;
  lastContactAt: Date | null;
  callbackAt: Date | null;
  textBackAt: Date | null;
  lastCall: {
    endedAt: Date | null;
    disposition: string | null;
    durationSeconds: number | null;
    aiSummary: string | null;
    recordingUrl: string | null;
    transcript: string | null;
  } | null;
  dncStatus: boolean;
  needsReview: boolean;
  automationPaused: boolean;
  consentStatus: string | null;
  assignedTo: string | null;
  /** Absent when the deployment has no APP_URL to build one from. */
  link: string | null;
}

/**
 * The chosen fields as plain values, keyed the way the outbound mapping names
 * them. A value EstatePulse does not have comes back null, which clears that
 * one cell rather than leaving a stale number sitting in somebody's base.
 */
export function writeBackValues(src: WriteBackSource): Record<string, string | number | boolean | null> {
  const at = (d: Date | null) => (d ? d.toISOString() : null);
  return {
    ep_status: src.status,
    ep_temperature: src.temperature,
    ep_score: src.score,
    ep_buying_intent: src.buyingIntent,
    ep_timeline: src.timeline,
    ep_financing_status: src.financingStatus,
    ep_follow_up_reason: src.followUpReason,
    ep_lost_reason: src.lostReason,
    ep_ai_summary: src.aiSummary,
    ep_memory_summary: src.memorySummary,
    ep_calls_made: src.callsMade,
    ep_first_contact_at: at(src.firstContactAt),
    ep_first_response_at: at(src.firstResponseAt),
    ep_last_contact_at: at(src.lastContactAt),
    ep_callback_at: at(src.callbackAt),
    ep_text_back_at: at(src.textBackAt),
    ep_last_call_at: at(src.lastCall?.endedAt ?? null),
    ep_last_call_disposition: src.lastCall?.disposition ?? null,
    ep_last_call_seconds: src.lastCall?.durationSeconds ?? null,
    ep_last_call_summary: src.lastCall?.aiSummary ?? null,
    ep_last_call_recording: src.lastCall?.recordingUrl ?? null,
    ep_last_call_transcript: src.lastCall?.transcript ?? null,
    // Booleans are always one or the other, so these never clear a cell.
    ep_do_not_contact: src.dncStatus,
    ep_needs_review: src.needsReview,
    ep_automation_paused: src.automationPaused,
    ep_consent_status: src.consentStatus,
    ep_assigned_to: src.assignedTo,
    ep_link: src.link,
  };
}
