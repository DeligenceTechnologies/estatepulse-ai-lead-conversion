/**
 * "Only if" for a strategy's step 2 and for sequence steps: rules matched all together (AND) or any
 * one of them (OR); no rules = always. The server checks the same shape and the same fields per place.
 */

export type ConditionField = 'call_result' | 'sms_reply';
export type ConditionOp = 'in' | 'not_in' | 'is';

export interface ConditionRule {
  field: ConditionField;
  op: ConditionOp;
  value: string | string[];
}

export interface OnlyIf {
  match: 'all' | 'any';
  rules: ConditionRule[];
}

export const ALWAYS: OnlyIf = { match: 'all', rules: [] };

/** Where a step sits: after the strategy's call, after its text, or in a sequence. */
export type ConditionContext = 'after_call' | 'after_sms' | 'sequence';

/** The choices each place offers, as the plain dropdown shows them; each is a rule set the server checks. */
export interface Preset {
  value: string;
  label: string;
  hint?: string;
  onlyIf: OnlyIf;
}

const NOT_ANSWERED_RULES: ConditionRule[] = [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }];
const NOT_ANSWERED_HINT = 'No answer, busy, voicemail or a short pick-up. Not a call that failed to connect or is still waiting to be dialed.';

export const PRESETS: Record<ConditionContext, Preset[]> = {
  after_call: [
    { value: 'always', label: 'Always', onlyIf: ALWAYS },
    { value: 'call_not_answered', label: 'Only if the call was not answered', hint: NOT_ANSWERED_HINT, onlyIf: { match: 'all', rules: NOT_ANSWERED_RULES } },
  ],
  after_sms: [
    { value: 'always', label: 'Always', onlyIf: ALWAYS },
    {
      value: 'no_reply',
      label: "Only if the lead hasn't replied",
      hint: 'Skipped once the lead has texted back.',
      onlyIf: { match: 'all', rules: [{ field: 'sms_reply', op: 'is', value: 'not_replied' }] },
    },
  ],
  sequence: [
    { value: 'always', label: 'Always', onlyIf: ALWAYS },
    { value: 'call_not_answered', label: 'Only if the last call was not answered', hint: NOT_ANSWERED_HINT, onlyIf: { match: 'all', rules: NOT_ANSWERED_RULES } },
  ],
};

const sameRules = (a: ConditionRule[], b: ConditionRule[]) =>
  a.length === b.length &&
  a.every((r, i) => {
    const o = b[i];
    const av = ([] as string[]).concat(r.value).sort().join(',');
    const bv = ([] as string[]).concat(o.value).sort().join(',');
    return r.field === o.field && r.op === o.op && av === bv;
  });

/** The preset a rule set is, or null when it is something else (set before, kept as it is). */
export function presetOf(onlyIf: OnlyIf | undefined, context: ConditionContext): Preset | null {
  const rules = onlyIf?.rules ?? [];
  return PRESETS[context].find((p) => sameRules(p.onlyIf.rules, rules)) ?? null;
}

/** What an older single condition on a step meant, as a rule set (the server maps it the same way). */
export function onlyIfOfStep(step: { onlyIf?: OnlyIf | null; condition?: string | null }): OnlyIf {
  if (step.onlyIf) return step.onlyIf;
  switch (step.condition) {
    case 'call_not_answered':
      return { match: 'all', rules: [{ field: 'call_result', op: 'in', value: ['no_answer', 'voicemail', 'busy', 'short_pickup'] }] };
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

/** How a call result reads inside a sentence. */
const CALL_WORDS: Record<string, string> = {
  no_answer: 'no answer',
  voicemail: 'voicemail',
  busy: 'busy/declined',
  short_pickup: 'a short pick-up',
  conversation: 'a conversation',
};

/** "a, b or c" */
const either = (words: string[]) => (words.length <= 1 ? (words[0] ?? '') : `${words.slice(0, -1).join(', ')} or ${words.at(-1)}`);

/** One rule in plain words, as the summary under a step reads it. */
export function ruleText(rule: ConditionRule): string {
  const values = ([] as string[]).concat(rule.value);
  if (rule.field === 'sms_reply') return values[0] === 'replied' ? 'the lead has replied' : "the lead hasn't replied";
  return `the call result is ${rule.op === 'not_in' ? 'not ' : ''}${either(values.map((v) => CALL_WORDS[v] ?? v))}`;
}

/** The whole "Only if" in words: empty when it is always. */
export function onlyIfText(onlyIf: OnlyIf | undefined): string {
  const rules = onlyIf?.rules ?? [];
  if (!rules.length) return '';
  return `only if ${rules.map(ruleText).join(onlyIf!.match === 'any' ? ', or ' : ', and ')}`;
}
