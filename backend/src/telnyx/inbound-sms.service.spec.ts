import { beforeEach, describe, expect, it, vi } from 'vitest';
import { InboundSmsService } from './inbound-sms.service';

/** Characterization: STOP, START and any other reply, as a lead texts back over Telnyx. */

const ORG = 'org-1';
const LEAD = 'lead-1';

function setup(opts: { org?: string | null; seen?: boolean; lead?: Record<string, unknown> | null } = {}) {
  const tx = { lead: { update: vi.fn(), updateMany: vi.fn() } };
  const prisma = {
    message: { findFirst: vi.fn().mockResolvedValue(opts.seen ? { id: 'm-old' } : null), create: vi.fn().mockResolvedValue({}) },
    lead: {
      findFirst: vi.fn().mockResolvedValue(opts.lead === undefined ? { id: LEAD, firstResponseAt: null } : opts.lead),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
    },
    $transaction: vi.fn(async (run: (t: typeof tx) => Promise<unknown>) => run(tx)),
  };
  const creds = { orgForNumber: vi.fn().mockResolvedValue(opts.org === undefined ? ORG : opts.org) };
  const followup = { stopForLead: vi.fn(), pauseForLead: vi.fn() };
  const service = new InboundSmsService(prisma as any, creds as any, followup as any);
  return { service, prisma, tx, creds, followup };
}

const text = (body: string, id = 'msg-1') => ({ id, from: { phone_number: '+1 (289) 555-0111' }, to: [{ phone_number: '+12025550100' }], text: body });

describe('InboundSmsService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('stores the reply against the newest lead with that number', async () => {
    const { service, prisma, creds } = setup();
    await service.onMessageReceived(text('Yes please call me'));
    expect(creds.orgForNumber).toHaveBeenCalledWith('+12025550100');
    expect(prisma.lead.findFirst).toHaveBeenCalledWith({
      where: { orgId: ORG, normalizedPhone: '+12895550111' },
      orderBy: { createdAt: 'desc' },
      select: { id: true, firstResponseAt: true },
    });
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ orgId: ORG, leadId: LEAD, senderType: 'lead', direction: 'inbound', channel: 'sms', body: 'Yes please call me', providerMessageId: 'msg-1' }),
    });
  });

  it.each(['STOP', 'stop', 'Stop!', 'STOP.', 'unsubscribe', 'Cancel', 'END', 'quit', 'opt-out', 'stopall'])('opts the lead out on "%s"', async (word) => {
    const { service, tx, followup } = setup();
    await service.onMessageReceived(text(word));
    expect(tx.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: expect.objectContaining({ dncStatus: true, automationPaused: true, status: 'not_interested', lostReason: 'Opted out by SMS', consentStatus: 'revoked' }),
    });
    expect(followup.stopForLead).toHaveBeenCalledWith(ORG, LEAD, 'opted_out', tx);
    expect(followup.pauseForLead).not.toHaveBeenCalled();
  });

  it('treats a sentence containing STOP as a human reply, not an opt-out', async () => {
    const { service, tx, followup } = setup();
    await service.onMessageReceived(text('please stop calling after 6'));
    expect(tx.lead.update).not.toHaveBeenCalled();
    expect(followup.pauseForLead).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('START lifts do-not-contact but leaves automation for a person to restart', async () => {
    const { service, tx } = setup();
    await service.onMessageReceived(text('START'));
    expect(tx.lead.updateMany).toHaveBeenCalledWith({
      where: { id: LEAD, dncStatus: true, status: 'not_interested' },
      data: { status: 'follow_up', followUpReason: 'other' },
    });
    expect(tx.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: expect.objectContaining({ dncStatus: false, consentStatus: 'granted', consentSource: 'sms_start' }) });
    expect(tx.lead.update.mock.calls[0][0].data).not.toHaveProperty('automationPaused');
  });

  it('any other reply pauses automation and the lead’s sequences', async () => {
    const { service, prisma, followup } = setup();
    await service.onMessageReceived(text('Who is this?'));
    expect(prisma.lead.update).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: { automationPaused: true, lastContactAt: expect.any(Date), firstResponseAt: expect.any(Date) },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, status: { in: ['new', 'follow_up'] } }, data: { status: 'contacting' } });
    expect(followup.pauseForLead).toHaveBeenCalledWith(ORG, LEAD);
  });

  it('ignores a delivery it has already stored', async () => {
    const { service, prisma, followup } = setup({ seen: true });
    await service.onMessageReceived(text('STOP'));
    expect(prisma.message.create).not.toHaveBeenCalled();
    expect(followup.stopForLead).not.toHaveBeenCalled();
  });

  it('ignores texts to a number no organization owns, or from no known lead', async () => {
    const unowned = setup({ org: null });
    await unowned.service.onMessageReceived(text('STOP'));
    const stranger = setup({ lead: null });
    await stranger.service.onMessageReceived(text('STOP'));
    expect(unowned.prisma.message.create).not.toHaveBeenCalled();
    expect(stranger.prisma.message.create).not.toHaveBeenCalled();
    expect(stranger.followup.stopForLead).not.toHaveBeenCalled();
  });
});
