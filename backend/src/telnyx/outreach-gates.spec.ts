import { describe, expect, it, vi } from 'vitest';
import { FollowupRunner } from '../modules/followup/followup.runner';
import { EngineService } from './engine.service';

/**
 * The only two places that text or call a lead are EngineService.fireStep and
 * FollowupRunner.execute. Both must re-read the lead at send time and refuse
 * one that is paused (every Google Sheets import starts paused, and stays so
 * until the owner approves it) or on the do-not-contact list. SMS and voice are
 * mocks here: nothing can be sent.
 */

const PAUSED = { id: 'lead-1', first_name: 'Ann', phone: '+15125550101', status: 'new', dnc_status: false, automation_paused: true };
const DNC = { ...PAUSED, dnc_status: true, automation_paused: false };

function senders() {
  return { sms: { sendSms: vi.fn() }, voice: { placeCall: vi.fn() } };
}

function engine(lead: object) {
  const { sms, voice } = senders();
  const prisma = {
    leads: { findFirst: vi.fn(async () => lead), findUnique: vi.fn(async () => lead), updateMany: vi.fn(async () => ({ count: 1 })) },
  };
  const e = new EngineService(prisma as never, {} as never, sms as never, voice as never, {} as never, {} as never);
  return { e, prisma, sms, voice };
}

const enrollment = () => ({ orgId: 'org-1', leadId: 'lead-1', voiceAttempts: 0, timers: [], stopped: false, ran: 0, total: 2, enrolledAt: Date.now(), quietShift: 0 });

describe('EngineService send gates', () => {
  for (const [label, lead] of [['paused (awaiting import review)', PAUSED], ['do-not-contact', DNC]] as const) {
    it(`does not enroll a ${label} lead, and does not claim it`, async () => {
      const { e, prisma, sms, voice } = engine(lead);
      await e.enroll('org-1', 'lead-1');
      expect(prisma.leads.updateMany).not.toHaveBeenCalled();
      expect(sms.sendSms).not.toHaveBeenCalled();
      expect(voice.placeCall).not.toHaveBeenCalled();
    });

    it(`stops instead of sending when the lead became ${label} after enrolment`, async () => {
      const { e, sms, voice } = engine(lead);
      const en = enrollment();
      for (const channel of ['sms', 'voice'] as const) {
        await (e as any).fireStep(en, { id: channel, channel, message: 'hi', after: { value: 0, unit: 'minutes' } }, 'Brokerage', 'UTC', {});
      }
      expect(sms.sendSms).not.toHaveBeenCalled();
      expect(voice.placeCall).not.toHaveBeenCalled();
      expect(en.stopped).toBe(true);
    });
  }
});

describe('FollowupRunner send gates', () => {
  function runner(lead: object) {
    const { sms, voice } = senders();
    const prisma = {
      leads: { findUnique: vi.fn(async () => lead) },
      sequence_enrollments: { update: vi.fn(async () => ({})) },
      sequence_steps: { findFirst: vi.fn(async () => ({ channel: 'sms', message: 'hi' })) },
    };
    const r = new FollowupRunner(prisma as never, {} as never, {} as never, sms as never, voice as never, {} as never);
    return { r, prisma, sms, voice };
  }
  const row = { id: 'enr-1', organization_id: 'org-1', lead_id: 'lead-1', sequence_id: 'seq-1', current_step: 1 };

  it('pauses the enrolment of a paused lead without sending', async () => {
    const { r, prisma, sms, voice } = runner(PAUSED);
    await (r as any).execute(row);
    expect(prisma.sequence_steps.findFirst).not.toHaveBeenCalled();
    expect(prisma.sequence_enrollments.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'paused' }) }));
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(voice.placeCall).not.toHaveBeenCalled();
  });

  it('stops the enrolment of a do-not-contact lead without sending', async () => {
    const { r, prisma, sms, voice } = runner(DNC);
    await (r as any).execute(row);
    expect(prisma.sequence_enrollments.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'stopped' }) }));
    expect(sms.sendSms).not.toHaveBeenCalled();
    expect(voice.placeCall).not.toHaveBeenCalled();
  });
});
