import { generateKeyPairSync, sign } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Extraction } from './lead-scoring';
import { LeadScoringService } from './lead-scoring.service';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG = 'org-1';
const LEAD = 'lead-1';
const CALL = { id: 'call-1', organization_id: ORG, lead_id: LEAD, extracted_intel: { raw: 'kept' }, handoff_requested: false, transcript: 'Channel 1: hello' };

const hotFacts: Extraction = {
  timeline: 'within_30_days',
  budget_identified: true,
  location_identified: true,
  pre_approved: true,
  appointment_requested: true,
  high_engagement: false,
  not_interested: false,
  invalid_lead: false,
  human_requested: false,
  summary: 'Ready to buy in Austin.',
};

function setup(opts: { leadStatus?: string; dnc?: boolean; latestCallId?: string; publicKey?: string } = {}) {
  const prisma: any = {
    organizations: { findUnique: vi.fn().mockResolvedValue({ lead_hot_threshold: 75, lead_warm_threshold: 45 }) },
    voice_calls: {
      findFirst: vi.fn().mockImplementation(({ where }: any) =>
        where.id ? Promise.resolve(CALL) : Promise.resolve({ id: opts.latestCallId ?? CALL.id }),
      ),
      update: vi.fn().mockResolvedValue({}),
    },
    leads: {
      findFirst: vi.fn().mockResolvedValue({ status: opts.leadStatus ?? 'contacted', dnc_status: !!opts.dnc }),
      update: vi.fn().mockResolvedValue({}),
    },
  };
  const unscoped: any = { voice_calls: { findFirst: vi.fn().mockResolvedValue(CALL) } };
  const creds: any = { getCreds: vi.fn().mockResolvedValue({ publicKey: opts.publicKey ?? '' }) };
  const insights: any = { extractFromTranscript: vi.fn().mockResolvedValue(hotFacts) };
  const engine: any = { qualified: vi.fn().mockResolvedValue(undefined) };
  const svc = new LeadScoringService(prisma, unscoped, creds, insights, engine);
  return { svc, prisma, engine, insights };
}

const insightPayload = (facts: unknown) => ({ results: [{ insight_id: 'other', result: 'free text' }, { insight_id: 'ours', result: JSON.stringify(facts) }] });
const unsigned = { signature: undefined, timestamp: undefined, rawBody: undefined };

describe('LeadScoringService', () => {
  beforeEach(() => vi.clearAllMocks());

  it('scores the Insight result, stores it on the call, and hands the lead off as hot', async () => {
    const { svc, prisma, engine } = setup();
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned);

    const callWrite = prisma.voice_calls.update.mock.calls[0][0];
    expect(callWrite.where).toEqual({ id: CALL.id });
    expect(callWrite.data.extracted_intel.raw).toBe('kept');
    expect(callWrite.data.extracted_intel.qualification).toMatchObject({ source: 'telnyx_insights', score: 80, temperature: 'hot' });
    expect(callWrite.data.ai_summary).toBe('Ready to buy in Austin.');

    expect(prisma.leads.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { score: 80 } });
    expect(engine.qualified).toHaveBeenCalledWith(ORG, LEAD, 'hot', expect.stringContaining('HOT — 80'));
  });

  it('ignores Insight results that are not ours', async () => {
    const { svc, prisma, engine } = setup();
    await svc.onInsightsGenerated('v3:ccid', { results: [{ result: 'Summarise the call' }] }, unsigned);
    expect(prisma.voice_calls.update).not.toHaveBeenCalled();
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('drops a delivery whose signature does not verify when the office has a public key', async () => {
    const { publicKey } = generateKeyPairSync('ed25519');
    const key = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32).toString('base64');
    const forger = generateKeyPairSync('ed25519').privateKey;
    const ts = String(Math.floor(Date.now() / 1000));
    const raw = Buffer.from('{}');
    const signature = sign(null, Buffer.concat([Buffer.from(`${ts}|`), raw]), forger).toString('base64');

    const { svc, prisma, engine } = setup({ publicKey: key });
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), { signature, timestamp: ts, rawBody: raw });
    expect(prisma.voice_calls.update).not.toHaveBeenCalled();
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('records a booked lead’s score and temperature without reopening it', async () => {
    const { svc, prisma, engine } = setup({ leadStatus: 'appointment_booked' });
    await svc.onInsightsGenerated('v3:ccid', insightPayload({ ...hotFacts, appointment_requested: false }), unsigned);
    expect(engine.qualified).not.toHaveBeenCalled();
    expect(prisma.leads.update).toHaveBeenCalledWith({ where: { id: LEAD }, data: { temperature: 'warm' } });
  });

  it.each(['appointment_booked', 'appointment_requested', 'not_interested', 'dnc', 'invalid', 'closed', 'booked', 'lost'])(
    'never walks a %s lead back to qualified or nurture',
    async (status) => {
      const { svc, engine } = setup({ leadStatus: status });
      await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned);
      expect(engine.qualified).not.toHaveBeenCalled();
    },
  );

  it('re-scores a lead that is only qualified', async () => {
    const { svc, engine } = setup({ leadStatus: 'qualified' });
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned);
    expect(engine.qualified).toHaveBeenCalled();
  });

  it('does not hand off a do-not-contact lead', async () => {
    const { svc, engine } = setup({ dnc: true });
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned);
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('a late result from an older call stays on that call and leaves the lead alone', async () => {
    const { svc, prisma, engine } = setup({ latestCallId: 'call-2' });
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned);
    expect(prisma.voice_calls.update).toHaveBeenCalledTimes(1);
    expect(prisma.leads.update).not.toHaveBeenCalled();
    expect(engine.qualified).not.toHaveBeenCalled();
  });

  it('uses the office thresholds', async () => {
    const { svc, prisma, engine } = setup();
    prisma.organizations.findUnique.mockResolvedValue({ lead_hot_threshold: 95, lead_warm_threshold: 60 });
    await svc.onInsightsGenerated('v3:ccid', insightPayload(hotFacts), unsigned); // 80
    expect(engine.qualified).toHaveBeenCalledWith(ORG, LEAD, 'warm', expect.any(String));
  });

  it('classifies a past call from its transcript, scoped to the caller’s organization', async () => {
    const { svc, prisma, insights } = setup();
    const q = await svc.classifyCall(ORG, CALL.id);
    expect(prisma.voice_calls.findFirst.mock.calls[0][0].where).toEqual({ id: CALL.id, organization_id: ORG });
    expect(insights.extractFromTranscript).toHaveBeenCalledWith(ORG, CALL.transcript);
    expect(q).toMatchObject({ source: 'transcript', score: 80, temperature: 'hot' });
  });

  it('refuses a call from another organization, and one with no transcript', async () => {
    const { svc, prisma } = setup();
    prisma.voice_calls.findFirst.mockResolvedValueOnce(null);
    await expect(svc.classifyCall('other-org', CALL.id)).rejects.toMatchObject({ code: 'NOT_FOUND' });
    prisma.voice_calls.findFirst.mockResolvedValueOnce({ ...CALL, transcript: '  ' });
    await expect(svc.classifyCall(ORG, CALL.id)).rejects.toMatchObject({ code: 'CONFLICT' });
  });
});
