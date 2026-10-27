/**
 * "Only if" on a strategy's step 2 or a sequence step: a flat list of rules matched all together
 * (AND) or any one of them (OR). No rules means always. Evaluated when the step is due, from facts
 * read then (the last call, replies).
 */

export type ConditionField = 'call_result' | 'sms_reply';
export type ConditionOp = 'in' | 'not_in' | 'is';

/**
 * How the last call went. 'failed' (the provider never placed it), 'none' (no call yet) and
 * 'pending' (still live or awaiting its analysis) cannot be picked, so `in` never matches them.
 */
export type CallOutcome = 'no_answer' | 'voicemail' | 'busy' | 'short_pickup' | 'conversation' | 'failed' | 'none' | 'pending';
export const PICKABLE_CALL_OUTCOMES = ['no_answer', 'voicemail', 'busy', 'short_pickup', 'conversation'] as const;
/** Every way a call can ring out without a conversation: what "the call was not answered" means. */
export const NOT_ANSWERED: CallOutcome[] = ['no_answer', 'voicemail', 'busy', 'short_pickup'];

export interface ConditionRule {
  field: ConditionField;
  op: ConditionOp;
  /** call_result: a list. sms_reply: one value. */
  value: string | string[];
}

export interface OnlyIf {
  match: 'all' | 'any';
  rules: ConditionRule[];
}

export const ALWAYS: OnlyIf = { match: 'all', rules: [] };
export const MAX_RULES = 10;

/** Where a step sits decides which facts mean something there. */
export type ConditionContext = 'after_call' | 'after_sms' | 'sequence';
const FIELDS_BY_CONTEXT: Record<ConditionContext, ConditionField[]> = {
  after_call: ['call_result'],
  after_sms: ['sms_reply'],
  sequence: ['call_result', 'sms_reply'],
};

const OPS: Record<ConditionField, ConditionOp[]> = {
  call_result: ['in', 'not_in'],
  sms_reply: ['is'],
};
const VALUES: Record<ConditionField, readonly string[]> = {
  call_result: PICKABLE_CALL_OUTCOMES,
  sms_reply: ['replied', 'not_replied'],
};

/** The rule set a step runs on: its own, or what its older single condition meant. Nothing is rewritten. */
export function onlyIfOf(step: { onlyIf?: OnlyIf | null; condition?: string | null }): OnlyIf {
  if (step.onlyIf) return step.onlyIf;
  switch (step.condition) {
    case 'call_not_answered':
      return { match: 'all', rules: [{ field: 'call_result', op: 'in', value: [...NOT_ANSWERED] }] };
    case 'no_reply':
      return { match: 'all', rules: [{ field: 'sms_reply', op: 'is', value: 'not_replied' }] };
    case 'not_reached':
      return {
        match: 'all',
        rules: [
          { field: 'call_result', op: 'not_in', value: ['conversation'] },
          { field: 'sms_reply', op: 'is', value: 'not_replied' },
        ],
      };
    default:
      return ALWAYS;
  }
}

/** What is wrong with a rule set for this step, in words for the owner; null when it is fine. */
export function onlyIfError(onlyIf: unknown, context: ConditionContext): string | null {
  const o = onlyIf as OnlyIf | null | undefined;
  if (!o || typeof o !== 'object') return 'The condition is missing.';
  if (o.match !== 'all' && o.match !== 'any') return 'Choose whether all or any of the conditions must hold.';
  if (!Array.isArray(o.rules)) return 'The condition has no rules list.';
  if (o.rules.length > MAX_RULES) return `At most ${MAX_RULES} conditions on a step.`;
  for (const rule of o.rules) {
    if (!rule || !FIELDS_BY_CONTEXT[context].includes(rule.field)) return `"${rule?.field}" cannot be used on this step.`;
    if (!OPS[rule.field].includes(rule.op)) return `"${rule.op}" does not apply to ${rule.field}.`;
    const values = Array.isArray(rule.value) ? rule.value : [rule.value];
    if (!values.length || values.some((v) => typeof v !== 'string')) return `Pick at least one value for ${rule.field}.`;
    if (rule.op === 'is' && Array.isArray(rule.value)) return `${rule.field} takes one value.`;
    if (values.some((v) => !VALUES[rule.field].includes(v))) return `A value for ${rule.field} is not one this field knows.`;
  }
  return null;
}

/** What is known about the lead when the step is due. */
export interface Facts {
  callOutcome: CallOutcome;
  smsReply: 'replied' | 'not_replied';
}

function holds(rule: ConditionRule, f: Facts): boolean {
  const values = Array.isArray(rule.value) ? rule.value : [rule.value];
  if (rule.field === 'sms_reply') return f.smsReply === values[0];
  const hit = values.includes(f.callOutcome);
  return rule.op === 'not_in' ? !hit : hit;
}

/** Empty = always. "all": every rule holds; "any": at least one does. A no names the rule that decided it. */
export function evaluate(onlyIf: OnlyIf, facts: Facts): { ok: true } | { ok: false; because: ConditionRule | null } {
  if (!onlyIf.rules.length) return { ok: true };
  if (onlyIf.match === 'any') return onlyIf.rules.some((r) => holds(r, facts)) ? { ok: true } : { ok: false, because: null };
  const failed = onlyIf.rules.find((r) => !holds(r, facts));
  return failed ? { ok: false, because: failed } : { ok: true };
}

export const usesField = (onlyIf: OnlyIf, field: ConditionField) => onlyIf.rules.some((r) => r.field === field);

const OUTCOME_WORDS: Record<CallOutcome, string> = {
  no_answer: 'no answer',
  voicemail: 'voicemail',
  busy: 'busy or declined',
  short_pickup: 'a short pick-up',
  conversation: 'a conversation',
  failed: 'a call that did not connect',
  none: 'no call yet',
  pending: 'a call not finished yet',
};

/** Why the step did not go, for the lead's page: the rule and what was found. */
export function skipDetail(because: ConditionRule | null, f: Facts): string {
  if (!because) return 'None of its conditions held';
  if (because.field === 'call_result') return `The call result was ${OUTCOME_WORDS[f.callOutcome]}`;
  return f.smsReply === 'replied' ? 'The lead replied' : 'The lead has not replied';
}
