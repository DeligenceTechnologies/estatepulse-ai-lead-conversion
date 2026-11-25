import { Inject, Injectable } from '@nestjs/common';
import { PLANS } from '@/billing/billing-plans';
import { EntitlementService } from '@/billing/entitlements/entitlement.service';
import { AppError } from '@/common/errors/app-error';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import type { TokenUsage } from './providers/model-provider';

/** US dollars per million tokens. */
interface Rates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Matched by longest prefix, since providers answer with dated model ids. Unknown models are charged at the highest rate. */
const RATES: [prefix: string, rates: Rates][] = (
  [
    ['claude-opus-5-5', { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 }],
    ['claude-sonnet-5-5', { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 }],
    ['gpt-5-nano', { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0 }],
    ['gpt-5-mini', { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0 }],
    ['gpt-5', { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 }],
    ['gpt-4.1-mini', { input: 0.4, output: 1.6, cacheRead: 0.1, cacheWrite: 0 }],
    ['gpt-4.1', { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 0 }],
    ['gpt-4o-mini', { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0 }],
    ['gpt-4o', { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 0 }],
  ] satisfies [string, Rates][]
).sort((a, b) => b[0].length - a[0].length);
const HIGHEST: Rates = { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 };

const ratesFor = (model: string): Rates => RATES.find(([prefix]) => model.startsWith(prefix))?.[1] ?? HIGHEST;

/** The highest plan allowance, used as a safety cap while billing is not enforced. */
const UNENFORCED_BUDGET_MICROS = Math.max(...Object.values(PLANS).map((p) => p.limits.assistantMonthlyBudgetMicros));

export interface UsageSummary {
  period: string;
  usedMicros: number;
  budgetMicros: number;
}

const currentPeriod = (now = new Date()) => now.toISOString().slice(0, 7);

/** Dollars per million tokens times tokens is exactly micro-dollars. */
export const costMicros = (model: string, u: TokenUsage): number => {
  const r = ratesFor(model);
  return Math.ceil(u.inputTokens * r.input + u.outputTokens * r.output + u.cacheReadTokens * r.cacheRead + u.cacheWriteTokens * r.cacheWrite);
};

@Injectable()
export class AssistantUsageService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly entitlements: EntitlementService,
  ) {}

  async summary(orgId: string): Promise<UsageSummary> {
    const period = currentPeriod();
    const [entitlements, row] = await Promise.all([
      this.entitlements.get(orgId),
      this.prisma.assistantUsage.findUnique({ where: { orgId_period: { orgId, period } }, select: { costMicros: true } }),
    ]);
    return {
      period,
      usedMicros: Number(row?.costMicros ?? 0n),
      budgetMicros: entitlements.enforced ? entitlements.limits.assistantMonthlyBudgetMicros : UNENFORCED_BUDGET_MICROS,
    };
  }

  async assertWithinBudget(orgId: string): Promise<void> {
    const { usedMicros, budgetMicros } = await this.summary(orgId);
    if (usedMicros >= budgetMicros) {
      throw new AppError('ASSISTANT_BUDGET_EXCEEDED', "The assistant has reached this month's limit for your plan. It resets on the 1st.", undefined, 429);
    }
  }

  async record(orgId: string, model: string, usage: TokenUsage): Promise<void> {
    const period = currentPeriod();
    const input = BigInt(usage.inputTokens + usage.cacheReadTokens + usage.cacheWriteTokens);
    const output = BigInt(usage.outputTokens);
    const cost = BigInt(costMicros(model, usage));
    await this.prisma.assistantUsage.upsert({
      where: { orgId_period: { orgId, period } },
      create: { orgId, period, inputTokens: input, outputTokens: output, costMicros: cost, requests: 1 },
      update: { inputTokens: { increment: input }, outputTokens: { increment: output }, costMicros: { increment: cost }, requests: { increment: 1 } },
    });
  }
}
