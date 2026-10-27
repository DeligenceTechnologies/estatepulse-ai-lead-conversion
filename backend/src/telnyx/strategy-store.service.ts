import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DEFAULT_LIMITS, fitConditions, limitsOf, skipDaysOf, type StepConditions, type StepVoicemail } from '@/followup/journey';

export interface StrategyStep {
  id: string;
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
  /** When the step runs at all; unset, always. */
  onlyIf?: StepConditions;
  /** A call step: what it leaves on an answering machine. Unset is the organization's setting. */
  voicemail?: StepVoicemail;
  /** A call step: why the AI is calling, given to it as {{call_context}}. */
  context?: string;
}

const UNIT_MS: Record<string, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** A step's own wait: after the step before it, or after enrolment for the first step. */
export const offsetMs = (after: StrategyStep['after']): number => (after?.value ?? 0) * (UNIT_MS[after?.unit] ?? 1000);

/** How long after enrolment each step is due: the waits of every step up to and including it. */
export function stepOffsets(steps: StrategyStep[]): number[] {
  let at = 0;
  return steps.map((step) => (at += offsetMs(step.after)));
}

export interface Strategy {
  name: string;
  guardrails: Record<string, unknown>;
  steps: StrategyStep[];
}

export function defaultStrategy(): Strategy {
  return {
    name: 'Outbound Communication Strategy',
    guardrails: {
      respectQuietHours: true,
      quietHours: { start: '21:00', end: '08:00' },
      maxVoiceAttempts: 3,
      stopOn: ['appointment_booked', 'human_takeover', 'dnc', 'qualified'],
      limits: { ...DEFAULT_LIMITS },
      skipDays: [],
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
        onlyIf: { lastCallMissed: true },
      },
    ],
  };
}

/** A step as stored: only the condition its place allows, and the call options only on a call step. */
function cleanStep(step: StrategyStep, previous: StrategyStep | undefined): StrategyStep {
  const { onlyIf, voicemail, context, ...rest } = step;
  const conditions = fitConditions(onlyIf, previous?.channel);
  const voice = step.channel === 'voice';
  return {
    ...rest,
    ...(conditions ? { onlyIf: conditions } : {}),
    ...(voice && voicemail && voicemail !== 'default' ? { voicemail } : {}),
    ...(voice && context?.trim() ? { context: context.trim() } : {}),
  };
}

/** The organization's outreach cadence for new leads: what is sent, through which channel, and when. */
@Injectable()
export class StrategyStoreService {
  constructor(private readonly prisma: PrismaService) {}

  /** Anything a saved strategy lacks (a strategy saved before a bug fix may have lost its guardrails) falls back to the default. */
  async getStrategy(orgId: string): Promise<Strategy> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { outreachStrategy: true } });
    const saved = settings?.outreachStrategy as unknown as Partial<Strategy> | null;
    const base = defaultStrategy();
    if (!saved) return base;
    return { ...base, ...saved, guardrails: { ...base.guardrails, ...(saved.guardrails ?? {}) } };
  }

  /** Only the fields the patch sets are changed: a validated DTO carries every optional field, unset ones as undefined. */
  async saveStrategy(orgId: string, patch: Partial<Strategy>): Promise<Strategy> {
    const set = Object.fromEntries(Object.entries(patch).filter(([, value]) => value !== undefined)) as Partial<Strategy>;
    const current = await this.getStrategy(orgId);
    const next: Strategy = { ...current, ...set };
    if (set.guardrails) {
      const g = { ...current.guardrails, ...set.guardrails };
      next.guardrails = { ...g, limits: limitsOf(g.limits), skipDays: skipDaysOf(g.skipDays) };
    }
    if (set.steps) next.steps = set.steps.map((step, i, all) => cleanStep(step, all[i - 1]));
    const outreachStrategy = next as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, outreachStrategy },
      update: { outreachStrategy },
    });
    return next;
  }
}
