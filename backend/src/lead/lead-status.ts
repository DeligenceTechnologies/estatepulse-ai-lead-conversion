import { LeadStatus } from '@prisma/client';

export const LEAD_STATUSES = Object.values(LeadStatus);

export const IN_STRATEGY_STATUSES: LeadStatus[] = [LeadStatus.new, LeadStatus.contacting];

export const OUTCOME_STATUSES: LeadStatus[] = [
  LeadStatus.interested,
  LeadStatus.appointment_requested,
  LeadStatus.appointment_booked,
  LeadStatus.not_interested,
  LeadStatus.invalid,
  LeadStatus.closed,
];

export const INACTIVE_STATUSES: LeadStatus[] = [LeadStatus.not_interested, LeadStatus.invalid, LeadStatus.closed];

export const REPLY_FROM: LeadStatus[] = [LeadStatus.new, LeadStatus.follow_up];

export const isLeadStatus = (value: unknown): value is LeadStatus =>
  typeof value === 'string' && (LEAD_STATUSES as string[]).includes(value);
