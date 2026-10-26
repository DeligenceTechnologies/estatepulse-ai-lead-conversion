import { createHmac } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { RetellWebhookController } from './retell-webhook.controller';

const ORG = 'org-1';
const LEAD = 'lead-1';
const KEY = 'key_webhook';

function request(body: unknown, key = KEY) {
  const raw = JSON.stringify(body);
  const ts = Date.now();
  const signature = `v=${ts},d=${createHmac('sha256', key).update(raw + ts).digest('hex')}`;
  return { header: (name: string) => (name === 'x-retell-signature' ? signature : undefined), rawBody: Buffer.from(raw) } as any;
}

function setup(call: Record<string, unknown> | null = {}, opts: { record?: boolean } = {}) {
  const row = call && { id: 'call-1', orgId: ORG, leadId: LEAD, provider: 'retell', providerCallId: 'call_abc', status: 'ringing', endedAt: null, ...call };
  const prisma = {
    call: { findFirst: vi.fn().mockResolvedValue(row), update: vi.fn() },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: opts.record ?? true }) },
  };
  const creds = { getCreds: vi.fn().mockResolvedValue({ webhookKey: KEY }) };
  const activity = { onCallAnswered: vi.fn(), onCallHangup: vi.fn() };
  const scoring = { onProviderAnalysis: vi.fn() };
  const engine = { setStatus: vi.fn().mockResolvedValue(undefined) };
  const controller = new RetellWebhookController(prisma as any, creds as any, activity as any, scoring as any, engine as any);
  const send = (event: string, payload: Record<string, unknown> = {}, key = KEY) => {
    const body = { event, call: { call_id: 'call_abc', ...payload } };
    return controller.receive(body, request(body, key));
  };
  return { send, prisma, activity, scoring, engine };
}

const analysis = { call_summary: 'Wants a 3-bed.', custom_analysis_data: { timeline: 'within_30_days', pre_approved: true } };

describe('RetellWebhookController', () => {
  beforeEach(() => vi.clearAllMocks());

  it('answers 404 for a call we have no record of yet, so Retell retries', async () => {
    const { send, activity } = setup(null);
    await expect(send('call_started')).rejects.toMatchObject({ status: 404 });
    expect(activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('refuses a delivery not signed with the workspace webhook key', async () => {
    const { send, activity } = setup();
    await expect(send('call_started', {}, 'some_other_key')).rejects.toMatchObject({ status: 401 });
    expect(activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('looks the call up as a Retell call', async () => {
    const { send, prisma } = setup();
    await send('call_started');
    expect(prisma.call.findFirst).toHaveBeenCalledWith({ where: { providerCallId: 'call_abc', provider: 'retell' }, orderBy: { createdAt: 'desc' } });
  });

  it('call_started marks the call answered, once', async () => {
    const first = setup();
    await first.send('call_started');
    expect(first.activity.onCallAnswered).toHaveBeenCalledWith('call_abc');
    const retried = setup({ status: 'in_progress' });
    await retried.send('call_started');
    const late = setup({ status: 'completed', endedAt: new Date() });
    await late.send('call_started');
    expect(retried.activity.onCallAnswered).not.toHaveBeenCalled();
    expect(late.activity.onCallAnswered).not.toHaveBeenCalled();
  });

  it('call_ended hangs up with Retell’s reason as the cause, once', async () => {
    const { send, activity } = setup({ status: 'in_progress' });
    await send('call_ended', { disconnection_reason: 'dial_no_answer' });
    expect(activity.onCallHangup).toHaveBeenCalledWith('call_abc', { hangup_cause: 'dial_no_answer' });
    const retried = setup({ status: 'completed', endedAt: new Date() });
    await retried.send('call_ended', { disconnection_reason: 'user_hangup' });
    expect(retried.activity.onCallHangup).not.toHaveBeenCalled();
  });

  it('a lead who asked on the call not to be contacted goes on our DNC', async () => {
    const { send, engine } = setup({ status: 'in_progress' });
    await send('call_ended', { disconnection_reason: 'user_requested_dnc' });
    expect(engine.setStatus).toHaveBeenCalledWith(ORG, LEAD, 'not_interested', expect.any(String), { optOut: true });
  });

  it('call_analyzed keeps the recording and transcript and scores a connected call', async () => {
    const { send, prisma, scoring } = setup({ status: 'completed', endedAt: new Date() });
    await send('call_analyzed', { recording_url: 'https://rec/1.wav', transcript: 'Agent: hi\nUser: hello', call_analysis: analysis });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { recordingUrl: 'https://rec/1.wav', transcript: 'Agent: hi\nUser: hello' } });
    expect(scoring.onProviderAnalysis).toHaveBeenCalledWith('call-1', expect.objectContaining({ timeline: 'within_30_days', pre_approved: true, summary: 'Wants a 3-bed.' }), 'retell_analysis');
  });

  it('with recording off, stores neither recording nor transcript, but still scores', async () => {
    const { send, prisma, scoring } = setup({ status: 'completed', endedAt: new Date() }, { record: false });
    await send('call_analyzed', { recording_url: 'https://rec/1.wav', transcript: 'Agent: hi', call_analysis: analysis });
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(scoring.onProviderAnalysis).toHaveBeenCalled();
  });

  it('does not score a call that never connected', async () => {
    const { send, scoring } = setup({ status: 'no_answer', endedAt: new Date() });
    await send('call_analyzed', { call_analysis: analysis });
    expect(scoring.onProviderAnalysis).not.toHaveBeenCalled();
  });
});
