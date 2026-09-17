import { Router, type Request, type Response, type NextFunction } from 'express';
import { requireAuth } from '../auth/requireAuth';
import * as credStore from './credStore';
import * as assistant from './assistant';
import * as numbers from './numbers';
import * as strategyStore from './strategyStore';
import * as engine from './engine';
import * as ingest from '../ingest/service';
import { prisma } from '../db';

/* eslint-disable @typescript-eslint/no-explicit-any */
// Map a DB leads row to the frontend Lead shape (camelCase). Enum-ish fields are cast client-side.
function mapLead(r: any) {
  return {
    id: r.id,
    organizationId: r.organization_id,
    assignedAgentId: r.takeover_user_id ?? '',
    firstName: r.first_name ?? '',
    lastName: r.last_name ?? '',
    email: r.email ?? '',
    phone: r.phone ?? '',
    source: 'Website',
    status: r.status ?? 'new',
    leadType: 'buyer',
    preferredLocation: r.location ?? '',
    budgetMin: r.min_budget != null ? Number(r.min_budget) : 0,
    budgetMax: r.max_budget != null ? Number(r.max_budget) : 0,
    propertyType: '',
    bedrooms: r.bedrooms ?? 0,
    timeline: r.timeline ?? '',
    financingStatus: r.financing_status ?? '',
    preapprovalStatus: false,
    score: r.score != null ? Number(r.score) : 0,
    temperature: r.temperature ?? 'cold',
    consentStatus: r.consent_status ?? 'pending',
    dncStatus: !!r.dnc_status,
    automationPaused: !!r.automation_paused,
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : new Date().toISOString(),
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : new Date().toISOString(),
    lastContactedAt: r.last_contact_at ? new Date(r.last_contact_at).toISOString() : undefined,
    notes: r.motivation ?? undefined,
  };
}

/**
 * All EstatePulse Telnyx / AI-agent routes. Mounted under /api, behind requireAuth,
 * so the org is always req.auth.organizationId (the real tenant from the JWT).
 */
export const telnyxRouter = Router();
telnyxRouter.use(requireAuth);

const orgOf = (req: Request): string => req.auth!.organizationId;

// Wrap an async handler and turn thrown errors into a provider-error envelope.
function h(fn: (req: Request, res: Response) => Promise<void>) {
  return (req: Request, res: Response, _next: NextFunction): void => {
    fn(req, res).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : 'Request failed';
      if (!res.headersSent) res.status(502).json({ error: { code: 'INTERNAL', message } });
    });
  };
}

// ---- Provider connection (Bring-Your-Own-Telnyx) ----
telnyxRouter.get('/telnyx/status', h(async (req, res) => {
  res.json(await credStore.publicStatus(orgOf(req)));
}));

telnyxRouter.put('/telnyx/credentials', h(async (req, res) => {
  const { apiKey, publicKey, connectionId, messagingProfileId, fromNumber } = req.body ?? {};
  if (apiKey !== undefined && (typeof apiKey !== 'string' || !/^KEY/.test(apiKey))) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A valid Telnyx API key (starts with "KEY") is required.' } });
    return;
  }

  const orgId = orgOf(req);
  const current = await credStore.getCreds(orgId); // null when connecting fresh
  const effectiveApiKey = (apiKey as string) || current?.apiKey || '';

  // Mandatory: a From Number to place calls from (E.164).
  const effectiveFrom = fromNumber !== undefined ? String(fromNumber) : current?.fromNumber || '';
  if (!/^\+?[0-9]{7,15}$/.test(effectiveFrom.replace(/[\s()-]/g, ''))) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A From Number in E.164 format (e.g. +12025550123) is required to place calls.' } });
    return;
  }

  // Mandatory: a Call Control Application must exist on the account (that's the
  // connection outbound calls dial through). Auto-detected from the API key.
  if (!effectiveApiKey) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'A Telnyx API key is required.' } });
    return;
  }
  const ccApp = (typeof connectionId === 'string' && connectionId) || (await credStore.findCallControlApp(effectiveApiKey));
  if (!ccApp) {
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'No Call Control Application found on your Telnyx account. Create one in Telnyx → Voice → Call Control → Applications (with a webhook URL), then connect again.',
      },
    });
    return;
  }

  // Auto-detect the messaging profile for SMS (the profile the from-number is on,
  // else the account's first enabled one). Not blocking — an org can be voice-only.
  const msgProfile = (typeof messagingProfileId === 'string' && messagingProfileId) || (await credStore.findMessagingProfile(effectiveApiKey, effectiveFrom));

  const patch: Record<string, string> = { connectionId: ccApp, fromNumber: effectiveFrom, messagingProfileId: msgProfile };
  if (apiKey) patch.apiKey = apiKey;
  if (publicKey !== undefined) patch.publicKey = publicKey;
  await credStore.saveCreds(orgId, patch);
  res.json(await credStore.publicStatus(orgId));
}));

telnyxRouter.delete('/telnyx/credentials', h(async (req, res) => {
  await credStore.clearCreds(orgOf(req)); // soft: status -> inactive (row kept)
  res.json(await credStore.publicStatus(orgOf(req)));
}));

// Reconnect — re-activate the stored integration without re-entering the key.
telnyxRouter.post('/telnyx/reconnect', h(async (req, res) => {
  await credStore.reconnect(orgOf(req));
  res.json(await credStore.publicStatus(orgOf(req)));
}));

// List the org's integrations from the DB (for the Integrations & Webhooks view).
telnyxRouter.get('/integrations', h(async (req, res) => {
  const rows = await prisma.integrations.findMany({ where: { organization_id: orgOf(req) }, orderBy: { created_at: 'asc' } });
  res.json({
    integrations: rows.map((r: any) => ({
      id: r.id,
      provider: r.provider,
      type: r.integration_type,
      status: r.status,
      externalAccountId: r.external_account_id ?? null,
      metadata: r.metadata ?? {},
      connectedAt: r.created_at ? new Date(r.created_at).toISOString() : null,
      updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
    })),
  });
}));

telnyxRouter.post('/telnyx/assistant/create', h(async (req, res) => {
  const a = await assistant.createAssistant(orgOf(req), req.body ?? {});
  res.status(201).json({ assistant: a, status: await credStore.publicStatus(orgOf(req)) });
}));

telnyxRouter.get('/telnyx/assistants', h(async (req, res) => {
  res.json({ assistants: await assistant.listAssistants(orgOf(req)) });
}));

telnyxRouter.post('/telnyx/assistant/attach', h(async (req, res) => {
  const { assistantId } = req.body ?? {};
  if (!assistantId) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'assistantId is required' } }); return; }
  const a = await assistant.setAssistantId(orgOf(req), assistantId);
  res.json({ assistant: a, status: await credStore.publicStatus(orgOf(req)) });
}));

// ---- Phone numbers ----
telnyxRouter.get('/telnyx/numbers/available', h(async (req, res) => {
  const { country, area, features, type, limit } = req.query as Record<string, string>;
  const list = await numbers.searchAvailable(orgOf(req), {
    country: country || 'US', areaCode: area || undefined,
    features: features ? String(features).split(',') : undefined, type: type || 'local',
    limit: limit ? Number(limit) : 10,
  });
  res.json({ numbers: list });
}));

telnyxRouter.get('/telnyx/numbers/owned', h(async (req, res) => {
  res.json({ numbers: await numbers.listOwned(orgOf(req)) });
}));

telnyxRouter.post('/telnyx/numbers/buy', h(async (req, res) => {
  const phone = (req.body ?? {}).phone_number;
  if (!phone) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'phone_number is required' } }); return; }
  res.status(201).json({ order: await numbers.buyNumber(orgOf(req), phone) });
}));

telnyxRouter.post('/telnyx/numbers/assign', h(async (req, res) => {
  const phone = (req.body ?? {}).phone_number;
  if (!phone) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'phone_number is required' } }); return; }
  const r = await numbers.assignNumber(orgOf(req), phone);
  res.json({ ...r, status: await credStore.publicStatus(orgOf(req)) });
}));

telnyxRouter.post('/telnyx/numbers/unassign', h(async (req, res) => {
  const phone = (req.body ?? {}).phone_number;
  if (!phone) { res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'phone_number is required' } }); return; }
  const r = await numbers.unassignNumber(orgOf(req), phone);
  res.json({ ...r, status: await credStore.publicStatus(orgOf(req)) });
}));

// ---- AI Agent config ----
telnyxRouter.get('/assistant', h(async (req, res) => {
  const a = await assistant.getAssistant(orgOf(req));
  if (!a) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'No AI agent configured' } }); return; }
  res.json({ assistant: a });
}));

telnyxRouter.patch('/assistant', h(async (req, res) => {
  res.json({ assistant: await assistant.updateAssistant(orgOf(req), req.body ?? {}) });
}));

telnyxRouter.get('/assistant/models', h(async (req, res) => {
  res.json({ models: await assistant.listModels(orgOf(req)) });
}));

// ---- Strategy ----
telnyxRouter.get('/strategy', h(async (req, res) => {
  res.json({ strategy: await strategyStore.getStrategy(orgOf(req)) });
}));

telnyxRouter.put('/strategy', h(async (req, res) => {
  res.json({ strategy: await strategyStore.saveStrategy(orgOf(req), req.body ?? {}) });
}));

// ---- Leads (org-scoped, real DB) ----
telnyxRouter.get('/leads', h(async (req, res) => {
  const rows = await prisma.leads.findMany({ where: { organization_id: orgOf(req) }, orderBy: { created_at: 'desc' }, take: 500 });
  res.json({ leads: rows.map(mapLead) });
}));

// ---- Engine (manual triggers; the watcher handles the automatic path) ----

// Enroll a lead now (also used by ingestion instead of waiting for the poll).
telnyxRouter.post('/leads/:id/enroll', h(async (req, res) => {
  await engine.enroll(orgOf(req), String(req.params.id));
  res.status(202).json({ ok: true });
}));

// The AI call reports the qualification result -> stop the strategy, hand off.
telnyxRouter.post('/leads/:id/qualified', h(async (req, res) => {
  const { temperature, summary } = req.body ?? {};
  if (!['hot', 'warm', 'cold'].includes(temperature)) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'temperature must be hot|warm|cold' } });
    return;
  }
  await engine.qualified(orgOf(req), String(req.params.id), temperature, summary);
  res.json({ ok: true });
}));

// ---- Lead ingestion sources (dashboard: mint/list/toggle webhook tokens) ----
telnyxRouter.get('/ingest/sources', h(async (req, res) => {
  res.json({ sources: await ingest.listSources(orgOf(req)) });
}));

// The plaintext token is returned ONCE here; only its hash is stored.
telnyxRouter.post('/ingest/sources', h(async (req, res) => {
  const label = String(req.body?.label ?? '').trim();
  if (!label) {
    res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: 'label is required' } });
    return;
  }
  res.status(201).json(await ingest.createSource(orgOf(req), label));
}));

telnyxRouter.patch('/ingest/sources/:id', h(async (req, res) => {
  const active = Boolean(req.body?.active);
  const ok = await ingest.setSourceActive(orgOf(req), String(req.params.id), active);
  if (!ok) {
    res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Source not found' } });
    return;
  }
  res.json({ ok: true, active });
}));

// ---- Lead flow: where is this lead in the journey (strategy step vs follow-up)? ----
telnyxRouter.get('/leads/:id/flow', h(async (req, res) => {
  const orgId = orgOf(req);
  const leadId = String(req.params.id);
  const lead = await prisma.leads.findFirst({ where: { id: leadId, organization_id: orgId } });
  if (!lead) { res.status(404).json({ error: { code: 'NOT_FOUND', message: 'Lead not found' } }); return; }

  const strategy = await strategyStore.getStrategy(orgId);
  const steps = strategy.steps ?? [];

  // Real outcomes, in order, so each step shows what actually happened.
  const calls = await prisma.voice_calls.findMany({ where: { organization_id: orgId, lead_id: leadId }, orderBy: { created_at: 'asc' }, select: { status: true } });
  const convs = await prisma.conversations.findMany({ where: { organization_id: orgId, lead_id: leadId, channel: 'sms' }, select: { id: true } });
  const msgs = convs.length
    ? await prisma.messages.findMany({ where: { conversation_id: { in: convs.map((c) => c.id) }, direction: 'outbound' }, orderBy: { created_at: 'asc' }, select: { delivery_status: true } })
    : [];

  // A voice_call status -> human outcome; likewise for an SMS delivery_status.
  const callOutcome = (s: string): { state: string; label: string } =>
    s === 'no_answer' ? { state: 'failed', label: 'No answer' }
    : s === 'failed' ? { state: 'failed', label: 'Call failed' }
    : s === 'completed' || s === 'in_progress' ? { state: 'done', label: 'Answered' }
    : { state: 'current', label: 'Ringing' };
  const smsOutcome = (s: string): { state: string; label: string } =>
    s === 'failed' ? { state: 'failed', label: 'SMS failed' } : { state: 'done', label: 'SMS sent' };

  // Walk the steps, consuming the matching activity per channel.
  let ci = 0;
  let mi = 0;
  const stepsOut = steps.map((s, i) => {
    let outcome: string | null = null;
    let state = 'pending';
    if (s.channel === 'voice') {
      if (ci < calls.length) { const o = callOutcome(calls[ci++].status); state = o.state; outcome = o.label; }
    } else if (mi < msgs.length) { const o = smsOutcome(msgs[mi++].delivery_status ?? ''); state = o.state; outcome = o.label; }
    return { index: i, channel: s.channel, action: s.action ?? s.channel, after: s.after, state, outcome };
  });
  const nextIndex = stepsOut.findIndex((s) => s.outcome === null);
  if (nextIndex >= 0) stepsOut[nextIndex].state = 'current';
  const fired = calls.length + msgs.length;

  const DONE = ['qualified', 'booked', 'closed', 'lost'];
  let phase: 'not_started' | 'strategy' | 'exited' | 'done';
  if (DONE.includes(lead.status)) phase = 'done';
  else if (lead.status === 'nurture') phase = 'exited';
  else if (lead.first_contact_at) phase = 'strategy';
  else phase = 'not_started';

  // The lead's real-world outcome label (what the user asked for): the best result so far.
  const answered = calls.some((c) => c.status === 'completed' || c.status === 'in_progress');
  const smsSent = msgs.some((m) => m.delivery_status === 'sent');
  let outcome: string;
  if (lead.status === 'qualified') outcome = 'Qualified';
  else if (lead.status === 'booked') outcome = 'Appointment booked';
  else if (lead.status === 'nurture') outcome = 'Exited strategy — follow-up needed';
  else if (answered) outcome = 'Call answered';
  else if (smsSent) outcome = 'SMS sent';
  else if (fired > 0) outcome = 'Attempted — no success yet';
  else phase === 'not_started' ? (outcome = 'Not started') : (outcome = 'In strategy');

  res.json({
    phase,
    leadStatus: lead.status,
    outcome,
    strategyName: strategy.name,
    stepsTotal: steps.length,
    completed: Math.min(fired, steps.length),
    currentStep: phase === 'strategy' && nextIndex >= 0 ? stepsOut[nextIndex] : null,
    steps: stepsOut,
    reason: lead.ai_summary ?? null,
  });
}));
