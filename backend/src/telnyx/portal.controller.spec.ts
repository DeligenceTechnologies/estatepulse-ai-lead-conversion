import { describe, expect, it, vi } from 'vitest';
import { PortalLeadsController } from './portal.controller';

/** The lead's journey through the strategy, as the lead detail shows it. */

const auth = { organizationId: 'org-1', userId: 'u-1', permissions: ['lead.read.all'], roleIds: [], sessionId: 's' } as any;
const steps = [
  { id: 's1', channel: 'sms', action: 'send_sms', after: { value: 0, unit: 'minutes' } },
  { id: 's2', channel: 'voice', action: 'ai_call', after: { value: 1, unit: 'minutes' } },
  { id: 's3', channel: 'voice', action: 'ai_call', after: { value: 5, unit: 'minutes' } },
];

function setup(sms: boolean, messages: { deliveryStatus: string }[]) {
  const prisma = {
    lead: { findFirst: vi.fn().mockResolvedValue({ id: 'lead-1', status: 'contacting', firstContactAt: new Date(), aiSummary: null }) },
    call: { findMany: vi.fn().mockResolvedValue([{ status: 'no_answer' }]) },
    message: { findMany: vi.fn().mockResolvedValue(messages) },
  };
  const strategies = { getStrategy: vi.fn().mockResolvedValue({ name: 'Default', steps }) };
  const providers = { for: vi.fn().mockResolvedValue({ name: sms ? 'telnyx' : 'retell', capabilities: { sms } }) };
  return new PortalLeadsController(prisma as any, {} as any, strategies as any, providers as any);
}

describe('PortalLeadsController.flow', () => {
  it('on Telnyx, matches texts and calls to their steps, as before', async () => {
    const flow = await setup(true, [{ deliveryStatus: 'sent' }]).flow(auth, 'lead-1');
    expect(flow.steps.map((s: any) => [s.state, s.outcome])).toEqual([
      ['done', 'SMS sent'],
      ['failed', 'No answer'],
      ['current', null],
    ]);
  });

  it('on Retell, marks SMS steps as not sent instead of waiting on them forever', async () => {
    const flow = await setup(false, []).flow(auth, 'lead-1');
    expect(flow.steps.map((s: any) => [s.state, s.outcome])).toEqual([
      ['skipped', 'Not sent'],
      ['failed', 'No answer'],
      ['current', null],
    ]);
    expect(flow.currentStep).toMatchObject({ index: 2, channel: 'voice' });
  });
});
