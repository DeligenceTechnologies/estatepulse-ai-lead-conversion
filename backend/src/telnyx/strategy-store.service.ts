import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import { ALWAYS, NOT_ANSWERED, onlyIfError, onlyIfOf, type OnlyIf } from '@/outreach/conditions';

/** The strategy is one SMS and one AI call; raise this (and the editor's rules) to allow more. */
export const MAX_STRATEGY_STEPS = 2;

/**
 * Either step may wait this long at most: step 1 after the lead comes in, step 2 after step 1. Past
 * a day the lead watcher would park an in-strategy lead as stalled, and a timer that long would not
 * survive a restart anyway.
 */
export const STEP_MAX_DELAY_MS = 12 * 3_600_000;

/** Older saved strategies' single condition on step 2; read through onlyIfOf, never written again. */
export type StepCondition = 'always' | 'call_not_answered' | 'no_reply';

export interface StrategyStep {
  id: string;
  /** Step 1: how long after the lead comes in. Step 2: how long after step 1 (a call: after it ends; a text: after it is sent). */
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
  /** Step 2's "Only if". */
  onlyIf?: OnlyIf;
  condition?: StepCondition;
}

const UNIT_MS: Record<string, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** A step's wait as milliseconds: after enrolment, or after the step before it for a two-step strategy. */
export const offsetMs = (after: StrategyStep['after']): number => (after?.value ?? 0) * (UNIT_MS[after?.unit] ?? 1000);

/**
 * Voicemail handling on AI calls: "Detect voicemail" in AI Settings. Kept with the strategy's
 * guardrails (one org-wide object both schedulers read), so no column was needed.
 */
export interface VoicemailConfig {
  /** Dial with answering machine detection. Off for every office until it turns it on: it is a per-call charge. */
  detect: boolean;
  /** Once a machine is heard: hang up, or leave `message` after the beep and then hang up. */
  action: 'hangup' | 'leave_message';
  /** {{firstName}} and {{brokerage}} are filled in. */
  message: string;
}

export const DEFAULT_VOICEMAIL_MESSAGE = "Hi {{firstName}}, this is {{brokerage}} calling about your home search. We'll send you a quick text.";
export const VOICEMAIL_MESSAGE_MAX = 300;

/** The voicemail settings a strategy carries; detection off for an office that never set them. */
export function voicemailOf(strategy: Pick<Strategy, 'guardrails'> | null | undefined): VoicemailConfig {
  const v = (strategy?.guardrails?.voicemail ?? {}) as Partial<VoicemailConfig>;
  return {
    detect: v.detect === true,
    action: v.action === 'leave_message' ? 'leave_message' : 'hangup',
    message: (typeof v.message === 'string' ? v.message : '').trim().slice(0, VOICEMAIL_MESSAGE_MAX) || DEFAULT_VOICEMAIL_MESSAGE,
  };
}

export interface Strategy {
  name: string;
  guardrails: Record<string, unknown>;
  steps: StrategyStep[];
  /**
   * 'after_previous': saved by the two-step editor; each wait counts from the step before it.
   * Absent: saved before it, any number of steps, each wait counted from enrolment. Such a
   * strategy runs as it always has until the owner saves it again.
   */
  timing?: 'after_previous';
}

export const isTwoStep = (strategy: Pick<Strategy, 'timing'>): boolean => strategy.timing === 'after_previous';

/** The default before conditional outreach: a text at once, a call a minute in, a text at five minutes. */
function legacyDefaultStrategy(): Strategy {
  return {
    name: 'Outbound Communication Strategy',
    guardrails: {
      respectQuietHours: true,
      quietHours: { start: '21:00', end: '08:00' },
      maxVoiceAttempts: 3,
      stopOn: ['appointment_booked', 'human_takeover', 'dnc', 'qualified'],
    },
    steps: [
      {
        id: 's1',
        after: { value: 0, unit: 'minutes' },
        channel: 'sms',
        action: 'send_sms',
        message:
          "Hi {{firstName}}, thanks for reaching out to {{brokerage}}! Are you looking to buy in the next few months? Reply anytime, or I'll give you a quick call.",
      },
      { id: 's2', after: { value: 1, unit: 'minutes' }, channel: 'voice', action: 'ai_call' },
      {
        id: 's3',
        after: { value: 5, unit: 'minutes' },
        channel: 'sms',
        action: 'send_sms',
        message: "Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?",
      },
    ],
  };
}

/** What an office that never saved a strategy runs. With conditional outreach off, what it ran before. */
export function defaultStrategy(conditional = true): Strategy {
  if (!conditional) return legacyDefaultStrategy();
  return {
    name: 'Outbound Communication Strategy',
    timing: 'after_previous',
    guardrails: {
      respectQuietHours: true,
      quietHours: { start: '21:00', end: '08:00' },
      maxVoiceAttempts: 3,
    },
    steps: [
      { id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'voice', action: 'ai_call' },
      {
        id: 's2',
        after: { value: 5, unit: 'minutes' },
        channel: 'sms',
        action: 'send_sms',
        onlyIf: { match: 'all', rules: [{ field: 'call_result', op: 'in', value: [...NOT_ANSWERED] }] },
        message: "Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?",
      },
    ],
  };
}

const blankStep = (channel: StrategyStep['channel']): StrategyStep =>
  channel === 'sms'
    ? { id: 'sms', after: { value: 0, unit: 'minutes' }, channel, action: 'send_sms', message: '' }
    : { id: 'call', after: { value: 0, unit: 'minutes' }, channel, action: 'ai_call' };

/** The largest unit that states the gap exactly. */
function waitOf(ms: number): StrategyStep['after'] {
  for (const unit of ['days', 'hours', 'minutes'] as const) {
    if (ms > 0 && ms % UNIT_MS[unit] === 0) return { value: ms / UNIT_MS[unit], unit };
  }
  return { value: Math.round(ms / 1000), unit: 'seconds' };
}

/** Step 2 in the editor's terms: its rule set, an older condition mapped onto one. */
const asEditable = ([first, second]: StrategyStep[]): StrategyStep[] => [
  { ...first, condition: undefined, onlyIf: undefined },
  { ...second, condition: undefined, onlyIf: onlyIfOf(second) },
];

/**
 * The strategy as the two-step editor shows it. An older one (more steps, two of a kind, waits
 * from enrolment) becomes its first call and first SMS in the order they really ran: the first
 * keeps its own start, the second waits the real gap after it (never less than zero), each capped
 * at the 12-hour limit. Nothing is written: the old strategy keeps running until this is saved.
 * `converted` says the editor shows something other than what is saved.
 */
export function toTwoStep(strategy: Strategy): { steps: StrategyStep[]; converted: boolean } {
  if (isTwoStep(strategy)) return { steps: asEditable(strategy.steps), converted: false };
  const inOrder = strategy.steps
    .map((step, index) => ({ step, index }))
    .sort((a, b) => offsetMs(a.step.after) - offsetMs(b.step.after) || a.index - b.index)
    .map((s) => s.step);
  const call = inOrder.find((s) => s.channel === 'voice');
  const sms = inOrder.find((s) => s.channel === 'sms');
  const [first, second] = [call, sms].filter((s): s is StrategyStep => !!s).sort((a, b) => inOrder.indexOf(a) - inOrder.indexOf(b));
  const one = first ?? blankStep('sms');
  const two = second ?? blankStep(one.channel === 'sms' ? 'voice' : 'sms');
  const start = Math.min(STEP_MAX_DELAY_MS, Math.max(0, offsetMs(one.after)));
  const gap = Math.min(STEP_MAX_DELAY_MS, Math.max(0, offsetMs(two.after) - offsetMs(one.after)));
  const steps: StrategyStep[] = [
    { ...one, after: start === offsetMs(one.after) ? one.after : waitOf(start), condition: undefined, onlyIf: undefined },
    { ...two, after: waitOf(gap), condition: undefined, onlyIf: ALWAYS },
  ];
  const converted =
    strategy.steps.length !== steps.length ||
    strategy.steps.some((s, i) => s !== inOrder[i]) ||
    !second ||
    start !== offsetMs(one.after) ||
    gap !== offsetMs(two.after) - offsetMs(one.after);
  return { steps, converted };
}

/**
 * The two-step rules: one SMS and one call; each wait at most 12 hours; no condition on step 1;
 * step 2's "Only if" uses only the facts that mean something after step 1.
 */
export function validateTwoStep(steps: StrategyStep[]): void {
  const fail = (path: string, message: string) => {
    throw new AppError('VALIDATION_ERROR', message, [{ path, message }]);
  };
  if (steps.length !== MAX_STRATEGY_STEPS || new Set(steps.map((s) => s.channel)).size !== MAX_STRATEGY_STEPS) {
    fail('steps', 'A strategy has exactly two steps: one SMS and one AI call.');
  }
  const [first, second] = steps;
  if (offsetMs(first.after) < 0 || offsetMs(first.after) > STEP_MAX_DELAY_MS) {
    fail('steps.0.after', 'Step 1 can start at most 12 hours after the lead comes in.');
  }
  if (offsetMs(second.after) < 0 || offsetMs(second.after) > STEP_MAX_DELAY_MS) {
    fail('steps.1.after', 'Step 2 can wait at most 12 hours after step 1.');
  }
  if (onlyIfOf(first).rules.length) fail('steps.0.onlyIf', 'The first step has no condition.');
  const problem = onlyIfError(onlyIfOf(second), second.channel === 'sms' ? 'after_call' : 'after_sms');
  if (problem) fail('steps.1.onlyIf', problem);
  steps.forEach((s, i) => {
    if (s.channel === 'sms' && !(s.message ?? '').trim()) fail(`steps.${i}.message`, 'The SMS step needs a message.');
  });
}

/** The organization's outreach cadence for new leads: what is sent, through which channel, and when. */
@Injectable()
export class StrategyStoreService {
  /** CONDITIONAL_OUTREACH_ENABLED: the two-step strategy, its conditions and the safety rules. Off, everything runs as before them. */
  readonly conditional: boolean;

  constructor(
    private readonly prisma: PrismaService,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.conditional = config.get('CONDITIONAL_OUTREACH_ENABLED', { infer: true }) === true;
  }

  async getStrategy(orgId: string): Promise<Strategy> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { outreachStrategy: true } });
    return (settings?.outreachStrategy as unknown as Strategy | null) ?? defaultStrategy(this.conditional);
  }

  /**
   * With conditional outreach on, saving steps saves the two-step form; a save of only the name or
   * guardrails leaves the steps as they are. Off, the strategy is stored as sent, as it always was.
   */
  async saveStrategy(orgId: string, patch: Partial<Strategy>): Promise<Strategy> {
    const next: Strategy = { ...(await this.getStrategy(orgId)), ...patch };
    if (patch.steps && this.conditional) {
      validateTwoStep(patch.steps);
      next.steps = asEditable(patch.steps);
      next.timing = 'after_previous';
    }
    const outreachStrategy = next as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, outreachStrategy },
      update: { outreachStrategy },
    });
    return next;
  }
}
