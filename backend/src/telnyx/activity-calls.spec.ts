import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/** Characterization: how a call's row moves as Telnyx reports it answered and hung up. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const NOW = new Date('2026-10-26T15:00:00Z');

function setup(call: Record<string, unknown> | null) {
  const prisma = {
    call: {
      findFirst: vi.fn().mockResolvedValue(call),
      update: vi.fn().mockResolvedValue({}),
      create: vi.fn().mockResolvedValue({}),
      count: vi.fn().mockResolvedValue(0),
    },
    lead: { update: vi.fn().mockResolvedValue({}), updateMany: vi.fn().mockResolvedValue({ count: 1 }), findUnique: vi.fn() },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: false }) },
  };
  const creds = { getCreds: vi.fn().mockResolvedValue(null) };
  const slots = { extend: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) };
  const activity = new ActivityService(prisma as any, creds as any, {} as any, {} as any, slots as any, { get: () => 0 } as any);
  return { activity, prisma, slots };
}

describe('ActivityService call bookkeeping', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });

  it('a dialed call is recorded as ringing from the moment it is placed', async () => {
    const { activity, prisma } = setup(null);
    await activity.startCall(ORG, LEAD, null);
    expect(prisma.call.create).toHaveBeenCalledWith({
      data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', providerCallId: null, status: 'ringing', startedAt: NOW },
    });
  });

  it('an answered call goes in progress, keeps its slot and counts as the lead responding', async () => {
    const { activity, prisma, slots } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing' });
    await activity.onCallAnswered('ccid-1');
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: expect.objectContaining({ status: 'in_progress' }) });
    expect(slots.extend).toHaveBeenCalledWith(ORG, 'ccid-1');
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { lastContactAt: NOW, firstResponseAt: NOW } });
  });

  it('a hang-up after an answer completes the call, timed from when it was placed', async () => {
    const { activity, prisma, slots } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'in_progress', startedAt: new Date(NOW.getTime() - 95_000) });
    await activity.onCallHangup('ccid-1', { hangup_cause: 'normal_clearing' });
    expect(slots.release).toHaveBeenCalledWith(ORG, 'ccid-1');
    // Audit fix B11 added the end reason to the row.
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { status: 'completed', endedAt: NOW, durationSeconds: 95, endReason: 'normal_clearing' } });
  });

  it('a hang-up before any answer is no answer, busy included', async () => {
    const { activity, prisma } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing', startedAt: new Date(NOW.getTime() - 30_000) });
    await activity.onCallHangup('ccid-1', { hangup_cause: 'user_busy' });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { status: 'no_answer', endedAt: NOW, durationSeconds: 30, endReason: 'user_busy' } });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD }, data: { aiSummary: 'No answer on the last call (user_busy)', lastContactAt: NOW } });
  });

  it('a call that could not be placed is recorded as failed', async () => {
    const { activity, prisma } = setup(null);
    await activity.recordCallFailed(ORG, LEAD, 'invalid number');
    expect(prisma.call.create).toHaveBeenCalledWith({ data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', status: 'failed', startedAt: NOW, endedAt: NOW } });
  });
});

describe('ActivityService hang-up causes (Telnyx call.hangup: hangup_cause + sip_hangup_cause)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW);
  });
  const ringing = { id: 'call-1', orgId: ORG, leadId: LEAD, status: 'ringing', startedAt: new Date(NOW.getTime() - 5_000) };
  const invalidated = (prisma: ReturnType<typeof setup>['prisma']) =>
    prisma.lead.updateMany.mock.calls.some(([arg]: any[]) => arg?.data?.status === 'invalid');

  it.each([
    ['not_found', 'unspecified'],
    ['unspecified', '404'],
    ['unspecified', '410'],
    ['unspecified', '484'],
  ])('a dead number (%s, SIP %s) marks the lead invalid', async (hangup_cause, sip_hangup_cause) => {
    const { activity, prisma } = setup(ringing);
    await activity.onCallHangup('ccid-1', { hangup_cause, sip_hangup_cause } as any);
    expect(invalidated(prisma)).toBe(true);
  });

  it('busy, declined and no answer are kept as the reason the call ended, and never mark the lead invalid', async () => {
    for (const [hangup_cause, sip_hangup_cause, reason] of [
      ['user_busy', '486', 'user_busy'],
      ['call_rejected', '603', 'call_rejected'],
      ['timeout', 'unspecified', 'timeout'],
      ['unspecified', '486', 'user_busy'],
    ]) {
      const { activity, prisma } = setup(ringing);
      await activity.onCallHangup('ccid-1', { hangup_cause, sip_hangup_cause } as any);
      expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: expect.objectContaining({ status: 'no_answer', endReason: reason }) });
      expect(invalidated(prisma)).toBe(false);
    }
  });
});

describe('ActivityService answering machine detection', () => {
  it.each([
    ['machine', 'machine'],
    ['silence', 'machine'],
    ['fax_detected', 'machine'],
    ['human_residence', 'human'],
    ['human_business', 'human'],
    ['not_sure', 'human'],
  ])('premium detection "%s" is kept as answered by %s', async (result, by) => {
    const { activity, prisma } = setup({ id: 'call-1', orgId: ORG, leadId: LEAD, status: 'in_progress' });
    await activity.onMachineDetection('ccid-1', { result });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { answeredBy: by } });
  });
});
