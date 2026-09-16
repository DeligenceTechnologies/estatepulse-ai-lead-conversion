import { prisma } from '../db.js';

/**
 * The org's single editable outbound strategy (voice + SMS steps), persisted in an
 * `integrations` row (provider='estatepulse', integration_type='other', metadata.strategy).
 */
const PROVIDER = 'estatepulse';
const TYPE = 'other';

export interface StrategyStep {
  id: string;
  after: { value: number; unit: 'seconds' | 'minutes' | 'hours' | 'days' };
  channel: 'sms' | 'voice';
  action?: string;
  template?: string;
  message?: string;
}
export interface Strategy {
  name: string;
  guardrails: Record<string, unknown>;
  steps: StrategyStep[];
}

function defaultStrategy(): Strategy {
  return {
    name: 'Outbound Communication Strategy',
    guardrails: { respectQuietHours: true, quietHours: { start: '21:00', end: '08:00' }, maxVoiceAttempts: 3, stopOn: ['appointment_booked', 'human_takeover', 'dnc', 'qualified'] },
    steps: [
      { id: 's1', after: { value: 0, unit: 'minutes' }, channel: 'sms', action: 'send_sms', message: "Hi {{firstName}}, thanks for reaching out to {{brokerage}}! Are you looking to buy in the next few months? Reply anytime, or I'll give you a quick call." },
      { id: 's2', after: { value: 1, unit: 'minutes' }, channel: 'voice', action: 'ai_call' },
      { id: 's3', after: { value: 5, unit: 'minutes' }, channel: 'sms', action: 'send_sms', message: "Hi {{firstName}}, just tried you with a quick call about your home search. When's a good time to chat?" },
    ],
  };
}

function rowFor(orgId: string) {
  return prisma.integrations.findFirst({ where: { organization_id: orgId, provider: PROVIDER, integration_type: TYPE }, orderBy: { created_at: 'asc' } });
}

export async function getStrategy(orgId: string): Promise<Strategy> {
  const r = await rowFor(orgId);
  const stored = (r?.metadata as { strategy?: Strategy } | null)?.strategy;
  if (stored) return stored;
  const def = defaultStrategy();
  await saveStrategy(orgId, def);
  return def;
}

export async function saveStrategy(orgId: string, strategy: Partial<Strategy>): Promise<Strategy> {
  const existing = await rowFor(orgId);
  const cur = (existing?.metadata as { strategy?: Strategy } | null)?.strategy ?? defaultStrategy();
  const next: Strategy = { ...cur, ...strategy } as Strategy;
  const metadata = { strategy: next };
  if (existing) await prisma.integrations.update({ where: { id: existing.id }, data: { metadata: metadata as object, updated_at: new Date() } });
  else await prisma.integrations.create({ data: { organization_id: orgId, provider: PROVIDER, integration_type: TYPE, status: 'active', metadata: metadata as object } });
  return next;
}
