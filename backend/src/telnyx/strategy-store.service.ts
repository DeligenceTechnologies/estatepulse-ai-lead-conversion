import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';

export interface StrategyStep {
  id: string;
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
}

const UNIT_MS: Record<string, number> = { seconds: 1_000, minutes: 60_000, hours: 3_600_000, days: 86_400_000 };

/** How long after enrolment a step runs. */
export const offsetMs = (after: StrategyStep['after']): number => (after?.value ?? 0) * (UNIT_MS[after?.unit] ?? 1000);

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

/** The organization's outreach cadence for new leads: what is sent, through which channel, and when. */
@Injectable()
export class StrategyStoreService {
  constructor(private readonly prisma: PrismaService) {}

  async getStrategy(orgId: string): Promise<Strategy> {
    const settings = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { outreachStrategy: true } });
    return (settings?.outreachStrategy as unknown as Strategy | null) ?? defaultStrategy();
  }

  async saveStrategy(orgId: string, patch: Partial<Strategy>): Promise<Strategy> {
    const next: Strategy = { ...(await this.getStrategy(orgId)), ...patch };
    const outreachStrategy = next as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, outreachStrategy },
      update: { outreachStrategy },
    });
    return next;
  }
}
