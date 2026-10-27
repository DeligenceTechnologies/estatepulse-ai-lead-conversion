import { LeadStatus } from '@prisma/client';

/**
 * The checks that stop or hold an automated step whatever the owner set. Each is enforced where its
 * `check` names it: the lead's own state (leadStop below, read by the strategy engine and the
 * sequence runner), and the step guard (booking, calls, contact hours). The strategy and sequence
 * screens show this list as it is, so a rule appears there only once the code enforces it.
 */
export type SafetyCheck =
  | 'opted_out'
  | 'meeting_booked'
  | 'not_interested'
  | 'wrong_number'
  | 'with_agent'
  | 'closed'
  | 'automation_paused'
  | 'call_answered'
  | 'call_pending'
  | 'contact_hours';

export interface SafetyRule {
  id: string;
  label: string;
  /** never_sends: the step is dropped; waits: it goes once the rule no longer holds. */
  kind: 'never_sends' | 'waits';
  check: SafetyCheck;
  appliesTo: ('strategy' | 'sequence')[];
}

const BOTH: SafetyRule['appliesTo'] = ['strategy', 'sequence'];

export const SAFETY_RULES: SafetyRule[] = [
  { id: 'meeting_booked', label: 'A meeting is booked', kind: 'never_sends', check: 'meeting_booked', appliesTo: BOTH },
  // A reply pauses automation; "Resume automation" on the lead lifts that pause, reply or not — so the label says so.
  { id: 'lead_replied', label: 'The lead replied by SMS (until you resume automation)', kind: 'never_sends', check: 'automation_paused', appliesTo: BOTH },
  { id: 'opted_out', label: 'The lead opted out (STOP, or asked on a call)', kind: 'never_sends', check: 'opted_out', appliesTo: BOTH },
  { id: 'not_interested', label: 'The lead said they are not interested', kind: 'never_sends', check: 'not_interested', appliesTo: BOTH },
  { id: 'wrong_number', label: 'Wrong or invalid number', kind: 'never_sends', check: 'wrong_number', appliesTo: BOTH },
  { id: 'agent_paused', label: 'Agent paused automation', kind: 'never_sends', check: 'automation_paused', appliesTo: BOTH },
  { id: 'with_agent', label: 'The lead is hot and with an agent', kind: 'never_sends', check: 'with_agent', appliesTo: BOTH },
  { id: 'closed', label: 'The lead is closed', kind: 'never_sends', check: 'closed', appliesTo: BOTH },
  { id: 'call_answered', label: 'A call was answered (its score decides what happens next)', kind: 'never_sends', check: 'call_answered', appliesTo: ['strategy'] },
  { id: 'call_pending', label: 'A call is still ringing, live, queued or being checked', kind: 'waits', check: 'call_pending', appliesTo: BOTH },
  { id: 'contact_hours', label: 'Outside contact hours', kind: 'waits', check: 'contact_hours', appliesTo: BOTH },
];

const BY_STATUS: Partial<Record<LeadStatus, SafetyCheck>> = {
  [LeadStatus.appointment_booked]: 'meeting_booked',
  [LeadStatus.not_interested]: 'not_interested',
  [LeadStatus.invalid]: 'wrong_number',
  [LeadStatus.interested]: 'with_agent',
  [LeadStatus.appointment_requested]: 'with_agent',
  [LeadStatus.closed]: 'closed',
};

/** The safety rule the lead's own state trips, if any: no automated step goes while it holds. */
export function leadStop(lead: { dncStatus: boolean; automationPaused: boolean; status: LeadStatus }): SafetyCheck | null {
  if (lead.dncStatus) return 'opted_out';
  return BY_STATUS[lead.status] ?? (lead.automationPaused ? 'automation_paused' : null);
}
