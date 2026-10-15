import { LeadStatus } from '@prisma/client';

/**
 * Lifecycle, left to right: new → contacting → interested → appointment_requested
 * → appointment_booked. Parked: follow_up (always with a reason). Out:
 * not_interested, invalid, closed. Opting out is not_interested plus dncStatus.
 */
export const LEAD_STATUSES = Object.values(LeadStatus);

/** The outreach strategy is still working the lead. */
export const IN_STRATEGY_STATUSES: LeadStatus[] = [LeadStatus.new, LeadStatus.contacting];

/** A result was reached: every automated step stops. */
export const OUTCOME_STATUSES: LeadStatus[] = [
  LeadStatus.interested,
  LeadStatus.appointment_requested,
  LeadStatus.appointment_booked,
  LeadStatus.not_interested,
  LeadStatus.invalid,
  LeadStatus.closed,
];

/** Out of the pipeline: nobody is working these. */
export const INACTIVE_STATUSES: LeadStatus[] = [LeadStatus.not_interested, LeadStatus.invalid, LeadStatus.closed];

/** A reply puts a new or parked lead back in conversation. */
export const REPLY_FROM: LeadStatus[] = [LeadStatus.new, LeadStatus.follow_up];

export const isLeadStatus = (value: unknown): value is LeadStatus =>
  typeof value === 'string' && (LEAD_STATUSES as string[]).includes(value);
