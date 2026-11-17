import type { WorkingDay } from '@/common/utils/working-hours';

/**
 * Live call transfer: on an AI call, a lead who is ready (pre-approved, wants a showing) or who
 * asks for a person is put through to an agent. Agents are rung one after another, each for
 * `ringSeconds`, and the lead is put through as soon as one picks up (a voicemail is detected and
 * skipped). When nobody takes it the AI comes back and books a meeting, or sets a callback.
 */
export interface LiveTransferSettings {
  enabled: boolean;
  /** How long each agent's phone rings before the next agent is tried. */
  ringSeconds: number;
  /** How many agents are tried, one after another, before the AI books a meeting instead. */
  agentsPerTransfer: number;
  /** Transfer a lead the AI finds ready to move (pre-approved, budget, wants a showing). */
  onHotLead: boolean;
  /** Transfer a lead who asks to speak to a person. */
  onRequest: boolean;
  /** What the lead hears while agents are rung. */
  holdMessage: string;
}

export const RING_SECONDS_MIN = 10;
export const RING_SECONDS_MAX = 45;
export const AGENTS_PER_TRANSFER_MAX = 5;
export const HOLD_MESSAGE_MAX_CHARS = 300;

export const DEFAULT_HOLD_MESSAGE = 'Great, please stay on the line while I connect you with one of our agents. This may take a few moments.';

export const DEFAULT_LIVE_TRANSFER: LiveTransferSettings = {
  enabled: false,
  ringSeconds: 20,
  agentsPerTransfer: 2,
  onHotLead: true,
  onRequest: true,
  holdMessage: DEFAULT_HOLD_MESSAGE,
};

const whole = (value: unknown, min: number, max: number, fallback: number): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min && value <= max ? value : fallback;
const bool = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

export function liveTransferSettings(raw: unknown): LiveTransferSettings {
  const v = raw && typeof raw === 'object' && !Array.isArray(raw) ? (raw as Partial<LiveTransferSettings>) : {};
  const d = DEFAULT_LIVE_TRANSFER;
  return {
    enabled: bool(v.enabled, d.enabled),
    ringSeconds: whole(v.ringSeconds, RING_SECONDS_MIN, RING_SECONDS_MAX, d.ringSeconds),
    agentsPerTransfer: whole(v.agentsPerTransfer, 1, AGENTS_PER_TRANSFER_MAX, d.agentsPerTransfer),
    onHotLead: bool(v.onHotLead, d.onHotLead),
    onRequest: bool(v.onRequest, d.onRequest),
    holdMessage: typeof v.holdMessage === 'string' && v.holdMessage.trim() ? v.holdMessage.trim().slice(0, HOLD_MESSAGE_MAX_CHARS) : d.holdMessage,
  };
}

/** The transfer tool is on the assistant only when the switch is on and at least one trigger is. */
export const transferToolWanted = (s: LiveTransferSettings): boolean => s.enabled && (s.onHotLead || s.onRequest);

/** Why the AI asked for a transfer. */
export const TRANSFER_REASONS = ['hot_lead', 'requested_agent'] as const;
export type TransferReason = (typeof TRANSFER_REASONS)[number];

/** What the AI tells us about the lead, kept with the transfer. */
export interface TransferFacts {
  budget?: string;
  location?: string;
  preApproved?: boolean;
  showing?: string;
  summary?: string;
}

/** A ZIP code or a city name, compared without case, spacing or punctuation. */
export function normalizeArea(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** An agent's list as saved: normalized, without blanks or repeats, at most 200. */
export function cleanServiceAreas(areas: readonly string[]): string[] {
  return [...new Set(areas.map(normalizeArea).filter(Boolean))].slice(0, 200).map((a) => a.slice(0, 100));
}

/**
 * Whether an agent covers where the lead wants to buy. An agent with no areas covers everywhere,
 * and a lead with no known location matches everyone. Otherwise one of the agent's areas must
 * appear in the lead's location as a whole word ("austin" in "South Austin, TX 78704", "78704"
 * in the same).
 */
export function coversArea(serviceAreas: readonly string[], leadLocation: string | null | undefined): boolean {
  if (!serviceAreas.length) return true;
  const where = normalizeArea(leadLocation ?? '');
  if (!where) return true;
  const padded = ` ${where} `;
  return serviceAreas.some((area) => {
    const a = normalizeArea(area);
    return !!a && padded.includes(` ${a} `);
  });
}

/** The weekday (0 = Sunday) and HH:MM on a wall clock in `timeZone`. */
function wallClock(now: Date, timeZone: string): { day: number; hhmm: string } {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, weekday: 'short', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(now);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  const day = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(get('weekday'));
  return { day, hhmm: `${get('hour')}:${get('minute')}` };
}

/** Whether `now` falls inside the agent's working hours for that day, read in their own timezone. */
export function withinWorkingHours(workingHours: unknown, timeZone: string, now = new Date()): boolean {
  if (!Array.isArray(workingHours)) return false;
  let clock: { day: number; hhmm: string };
  try {
    clock = wallClock(now, timeZone);
  } catch {
    return false;
  }
  const today = (workingHours as WorkingDay[]).find((d) => d?.dayOfWeek === clock.day);
  if (!today?.isAvailable) return false;
  const { startTime, endTime } = today;
  if (typeof startTime !== 'string' || typeof endTime !== 'string') return false;
  // A shift that runs past midnight (22:00-06:00) covers both ends of the day.
  return startTime <= endTime ? clock.hhmm >= startTime && clock.hhmm < endTime : clock.hhmm >= startTime || clock.hhmm < endTime;
}
