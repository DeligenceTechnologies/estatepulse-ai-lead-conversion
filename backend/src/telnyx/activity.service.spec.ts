import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ActivityService } from './activity.service';

/** Characterization: what a Telnyx call writes, and what answering and hanging up do. */

const ORG = 'org-1';
const LEAD = 'lead-1';
const CCID = 'v3:cc-1';

function setup(opts: { record?: boolean; assistantId?: string; call?: Record<string, unknown> | null } = {}) {
  const call =
    opts.call === undefined
      ? { id: 'call-1', orgId: ORG, leadId: LEAD, provider: 'telnyx', status: 'ringing', startedAt: new Date(Date.now() - 30_000), transcript: null }
      : opts.call;
  const prisma = {
    call: { create: vi.fn(), update: vi.fn().mockResolvedValue({}), findFirst: vi.fn().mockResolvedValue(call), count: vi.fn().mockResolvedValue(0) },
    message: { create: vi.fn() },
    lead: {
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      findFirst: vi.fn().mockResolvedValue({ id: LEAD, firstName: 'Asha', lastName: 'Rao', phone: '+12895550111', email: null, location: 'Austin', minBudget: 300000, maxBudget: 450000 }),
      findUnique: vi.fn(),
    },
    organization: { findUnique: vi.fn().mockResolvedValue({ name: 'Acme Realty' }) },
    organizationSetting: { findUnique: vi.fn().mockResolvedValue({ callRecordingEnabled: opts.record ?? true }) },
  };
  const creds = { getCreds: vi.fn().mockResolvedValue({ apiKey: 'KEY123', assistantId: opts.assistantId ?? 'assistant-1' }) };
  const insights = { ensureProvisioned: vi.fn().mockResolvedValue(undefined) };
  const assistants = { ensureCallSetup: vi.fn().mockResolvedValue(undefined) };
  const slots = { extend: vi.fn().mockResolvedValue(undefined), release: vi.fn().mockResolvedValue(undefined) };
  const activity = new ActivityService(prisma as any, creds as any, insights as any, assistants as any, slots as any);
  return { activity, prisma, creds, insights, assistants, slots };
}

let fetchMock: ReturnType<typeof vi.fn>;
beforeEach(() => {
  fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

const actions = () =>
  fetchMock.mock.calls.map(([url, init]) => ({ url: String(url), body: JSON.parse(String((init as RequestInit).body)) }));

describe('ActivityService.startCall', () => {
  it('records a ringing Telnyx call and marks the lead contacted', async () => {
    const { activity, prisma } = setup();
    await activity.startCall(ORG, LEAD, CCID);
    expect(prisma.call.create).toHaveBeenCalledWith({
      data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', providerCallId: CCID, status: 'ringing', startedAt: expect.any(Date) },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, status: 'new' }, data: { status: 'contacting' } });
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { lastContactAt: expect.any(Date) } });
  });

  it('prepares the assistant while the call rings', async () => {
    const { activity, creds, assistants } = setup();
    await activity.startCall(ORG, LEAD, CCID);
    await vi.waitFor(() => expect(assistants.ensureCallSetup).toHaveBeenCalledWith(ORG));
    expect(creds.getCreds).toHaveBeenCalledWith(ORG);
  });

  it('records a failed attempt as a failed Telnyx call', async () => {
    const { activity, prisma } = setup();
    await activity.recordCallFailed(ORG, LEAD, 'boom');
    expect(prisma.call.create).toHaveBeenCalledWith({
      data: { orgId: ORG, leadId: LEAD, provider: 'telnyx', status: 'failed', startedAt: expect.any(Date), endedAt: expect.any(Date) },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD }, data: { aiSummary: 'Call failed: boom', lastContactAt: expect.any(Date) } });
  });
});

describe('ActivityService.onCallAnswered', () => {
  it('marks the call live, keeps its slot, then starts recording and the assistant with the lead as variables', async () => {
    const { activity, prisma, slots } = setup();
    await activity.startCall(ORG, LEAD, CCID);
    await activity.onCallAnswered(CCID);

    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { status: 'in_progress' } });
    expect(slots.extend).toHaveBeenCalledWith(ORG, CCID);
    expect(prisma.lead.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { lastContactAt: expect.any(Date), firstResponseAt: expect.any(Date) } });

    const sent = actions();
    expect(sent.map((a) => a.url)).toEqual([
      `https://api.telnyx.com/v2/calls/${CCID}/actions/record_start`,
      `https://api.telnyx.com/v2/calls/${CCID}/actions/ai_assistant_start`,
    ]);
    expect(sent[0].body).toEqual({ format: 'mp3', channels: 'dual', transcription: true });
    expect(sent[1].body).toEqual({
      assistant: { id: 'assistant-1' },
      dynamic_variables: expect.objectContaining({ firstName: 'Asha', fullName: 'Asha Rao', location: 'Austin', brokerage: 'Acme Realty', leadId: LEAD }),
    });
  });

  it('does not record when the organization switched recording off', async () => {
    const { activity } = setup({ record: false });
    await activity.startCall(ORG, LEAD, CCID);
    await activity.onCallAnswered(CCID);
    expect(actions().map((a) => a.url)).toEqual([`https://api.telnyx.com/v2/calls/${CCID}/actions/ai_assistant_start`]);
  });

  it('prepares the attach on answer when the ring was missed (e.g. after a restart)', async () => {
    const { activity } = setup();
    await activity.onCallAnswered(CCID);
    expect(actions().map((a) => a.url.split('/').at(-1))).toEqual(['record_start', 'ai_assistant_start']);
  });

  it('does nothing for a call we have no record of', async () => {
    const { activity, prisma } = setup({ call: null });
    await activity.onCallAnswered(CCID);
    expect(prisma.call.update).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ActivityService with a non-Telnyx call', () => {
  const retellCall = { id: 'call-1', orgId: ORG, leadId: LEAD, provider: 'retell', status: 'ringing', startedAt: new Date() };

  it('labels the call with its provider and prepares no Telnyx assistant', async () => {
    const { activity, prisma, creds } = setup({ call: retellCall });
    await activity.startCall(ORG, LEAD, 'call_abc', 'retell');
    await activity.recordCallFailed(ORG, LEAD, 'boom', 'retell');
    expect(prisma.call.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'retell', providerCallId: 'call_abc', status: 'ringing' }) });
    expect(prisma.call.create).toHaveBeenCalledWith({ data: expect.objectContaining({ provider: 'retell', status: 'failed' }) });
    expect(creds.getCreds).not.toHaveBeenCalled();
  });

  it('on answer does the bookkeeping only: no Telnyx recording, no Telnyx assistant', async () => {
    const { activity, prisma, slots, creds } = setup({ call: retellCall });
    await activity.onCallAnswered('call_abc');
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { status: 'in_progress' } });
    expect(slots.extend).toHaveBeenCalledWith(ORG, 'call_abc');
    expect(creds.getCreds).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('ActivityService.onCallHangup', () => {
  it('completes an answered call and frees its slot', async () => {
    const { activity, prisma, slots } = setup({ call: { id: 'call-1', orgId: ORG, leadId: LEAD, status: 'in_progress', startedAt: new Date(Date.now() - 60_000) } });
    await activity.onCallHangup(CCID, { hangup_cause: 'normal_clearing' });
    expect(slots.release).toHaveBeenCalledWith(ORG, CCID);
    expect(prisma.call.update).toHaveBeenCalledWith({
      where: { id: 'call-1' },
      data: { status: 'completed', endedAt: expect.any(Date), durationSeconds: expect.any(Number) },
    });
    expect(prisma.lead.updateMany).not.toHaveBeenCalled();
  });

  it('records an unanswered call as no answer, with the cause', async () => {
    const { activity, prisma } = setup();
    await activity.onCallHangup(CCID, { hangup_cause: 'timeout' });
    expect(prisma.call.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'no_answer' }) }));
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: LEAD },
      data: { aiSummary: 'No answer on the last call (timeout)', lastContactAt: expect.any(Date) },
    });
  });

  it('marks the lead invalid when the number does not exist', async () => {
    const { activity, prisma } = setup();
    await activity.onCallHangup(CCID, { hangup_cause: 'unallocated_number' });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({
      where: { id: LEAD, status: { in: ['new', 'contacting', 'follow_up'] } },
      data: { status: 'invalid', lostReason: 'Invalid number (unallocated_number)', aiSummary: 'Invalid number (unallocated_number)' },
    });
  });
});

describe('ActivityService recording and transcript', () => {
  it('keeps the mp3 link and appends transcription text', async () => {
    const { activity, prisma } = setup({ call: { id: 'call-1', orgId: ORG, leadId: LEAD, status: 'completed', transcript: 'Channel 1: hi' } });
    await activity.onRecordingSaved(CCID, { recording_urls: { mp3: 'https://rec/1.mp3', wav: 'https://rec/1.wav' } });
    await activity.onTranscriptionSaved(CCID, { transcription_text: 'Channel 2: hello' });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { recordingUrl: 'https://rec/1.mp3' } });
    expect(prisma.call.update).toHaveBeenCalledWith({ where: { id: 'call-1' }, data: { transcript: 'Channel 1: hi\nChannel 2: hello' } });
  });
});

describe('ActivityService.recordSms', () => {
  it('stores a sent text and marks the lead contacted', async () => {
    const { activity, prisma } = setup();
    await activity.recordSms(ORG, LEAD, 'Hi Asha', true, 'msg-1');
    expect(prisma.message.create).toHaveBeenCalledWith({
      data: {
        orgId: ORG,
        leadId: LEAD,
        senderType: 'ai',
        direction: 'outbound',
        channel: 'sms',
        body: 'Hi Asha',
        providerMessageId: 'msg-1',
        deliveryStatus: 'sent',
        sentAt: expect.any(Date),
      },
    });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD, status: 'new' }, data: { status: 'contacting' } });
  });

  it('stores a failed text with the reason on the lead', async () => {
    const { activity, prisma } = setup();
    await activity.recordSms(ORG, LEAD, 'Hi Asha', false, 'No provider connected');
    expect(prisma.message.create).toHaveBeenCalledWith({ data: expect.objectContaining({ providerMessageId: null, deliveryStatus: 'failed', failedAt: expect.any(Date) }) });
    expect(prisma.lead.updateMany).toHaveBeenCalledWith({ where: { id: LEAD }, data: { aiSummary: 'SMS failed: No provider connected', lastContactAt: expect.any(Date) } });
  });
});
