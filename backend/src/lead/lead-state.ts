import { LeadStatus } from '@prisma/client';
import { REPLY_FROM } from './lead-status';

/** Still being worked or waiting on the lead: anything automation may conclude. */
const OPEN: LeadStatus[] = [
  LeadStatus.new,
  LeadStatus.contacting,
  LeadStatus.engaged,
  LeadStatus.follow_up,
  LeadStatus.interested,
  LeadStatus.appointment_requested,
  LeadStatus.unresponsive,
];

/**
 * The statuses automation may move a lead out of, for each status it moves
 * the lead into. A person changing the status by hand is not bound by this.
 *
 * - A booking wins over everything but a wrong number.
 * - A booked or closed lead is never moved back by automation; only a canceled
 *   or missed meeting (which names that source explicitly) parks it again.
 * - Unresponsive is only reached from follow_up, when a sequence runs out.
 */
export const AUTOMATION_FROM: Record<LeadStatus, readonly LeadStatus[]> = {
  [LeadStatus.new]: [],
  [LeadStatus.contacting]: [LeadStatus.new],
  [LeadStatus.engaged]: REPLY_FROM,
  [LeadStatus.follow_up]: [LeadStatus.new, LeadStatus.contacting, LeadStatus.engaged, LeadStatus.follow_up, LeadStatus.interested, LeadStatus.appointment_requested],
  [LeadStatus.interested]: OPEN,
  [LeadStatus.appointment_requested]: OPEN,
  [LeadStatus.appointment_booked]: Object.values(LeadStatus).filter((s) => s !== LeadStatus.invalid),
  [LeadStatus.not_interested]: OPEN,
  [LeadStatus.unresponsive]: [LeadStatus.follow_up],
  [LeadStatus.invalid]: OPEN,
  [LeadStatus.closed]: [],
};

export interface MoveRule {
  /** A person set it by hand: any move is allowed. */
  manual?: boolean;
  /** Narrows the moves to these source statuses, on top of the table. */
  onlyFrom?: readonly LeadStatus[];
  /** Allows these source statuses besides the table's, for a named exception (an opt-in, a canceled meeting). */
  alsoFrom?: readonly LeadStatus[];
}

export function canMove(from: LeadStatus, to: LeadStatus, rule: MoveRule = {}): boolean {
  if (rule.manual) return true;
  const allowed = AUTOMATION_FROM[to].includes(from) || Boolean(rule.alsoFrom?.includes(from));
  return allowed && (!rule.onlyFrom || rule.onlyFrom.includes(from));
}
