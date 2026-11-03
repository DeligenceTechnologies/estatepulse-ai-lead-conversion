import { LeadStatus } from '@prisma/client';

/**
 * Lifecycle, left to right: new → contacting → engaged → interested →
 * appointment_requested → appointment_booked. Parked: follow_up (always with a
 * reason). Out: not_interested, unresponsive, invalid, closed. Opting out is
 * not_interested plus dncStatus. Which move is allowed is in lead-state.ts.
 */
export const LEAD_STATUSES = Object.values(LeadStatus);

/** The outreach strategy is still working the lead. */
export const IN_STRATEGY_STATUSES: LeadStatus[] = [LeadStatus.new, LeadStatus.contacting, LeadStatus.engaged];

/** A result was reached: every automated step stops. */
export const OUTCOME_STATUSES: LeadStatus[] = [
  LeadStatus.interested,
  LeadStatus.appointment_requested,
  LeadStatus.appointment_booked,
  LeadStatus.not_interested,
  LeadStatus.unresponsive,
  LeadStatus.invalid,
  LeadStatus.closed,
];

/** Out of the pipeline: nobody is working these. */
export const INACTIVE_STATUSES: LeadStatus[] = [LeadStatus.not_interested, LeadStatus.unresponsive, LeadStatus.invalid, LeadStatus.closed];

/** A reply puts a lead that is not yet decided, parked or gone silent back in conversation. */
export const REPLY_FROM: LeadStatus[] = [LeadStatus.new, LeadStatus.contacting, LeadStatus.follow_up, LeadStatus.unresponsive];

export const isLeadStatus = (value: unknown): value is LeadStatus =>
  typeof value === 'string' && (LEAD_STATUSES as string[]).includes(value);

/** The lead asked to be called back at a time still ahead: until then the callback, not the strategy, decides. */
export function callbackPending(lead: { callbackAt: Date | null }, now = Date.now()): boolean {
  return !!lead.callbackAt && lead.callbackAt.getTime() > now;
}

/** The lead asked to be texted at a time still ahead: until then nothing else reaches them. */
export function textBackPending(lead: { textBackAt: Date | null }, now = Date.now()): boolean {
  return !!lead.textBackAt && lead.textBackAt.getTime() > now;
}

/** A step held for that text goes on this long after it, so the lead can answer it first. */
export const AFTER_TEXT_BACK_MS = 2 * 60_000;
/** A held step looks again this often, so a text the lead cancelled (by texting first) stops holding it. */
export const TEXT_BACK_RECHECK_MS = 5 * 60_000;

/** When a step held for that text looks again: just after it, or sooner. */
export function textBackRecheckAt(lead: { textBackAt: Date | null }, now = Date.now()): number {
  return Math.min((lead.textBackAt?.getTime() ?? now) + AFTER_TEXT_BACK_MS, now + TEXT_BACK_RECHECK_MS);
}
