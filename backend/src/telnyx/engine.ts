import { prisma } from '../db.js';
import { getStrategy, type StrategyStep } from './strategyStore.js';
import { sendSms } from './sms.js';
import { placeCall } from './voice.js';
import * as activity from './activity.js';

/**
 * Strategy execution engine. On a new lead it enrolls and fires the org's cadence
 * (SMS + AI call) with delays, compliance guardrails, and status updates on the real
 * `leads` table. In-process scheduler (setTimeout) — swap for a durable queue in prod.
 */
const UNIT_MS: Record<string, number> = { seconds: 1000, minutes: 60000, hours: 3600000, days: 86400000 };
const offsetMs = (a: StrategyStep['after']) => (a?.value ?? 0) * (UNIT_MS[a?.unit] ?? 1000);

interface Enrollment {
  orgId: string;
  leadId: string;
  voiceAttempts: number;
  timers: NodeJS.Timeout[];
  stopped: boolean;
}
const active = new Map<string, Enrollment>(); // leadId -> enrollment

function log(msg: string, extra?: unknown) {
  console.log(`[engine] ${msg}`, extra ?? '');
}

// Is `now` inside the org's quiet-hours window (org timezone)?
function inQuietHours(tz: string, quiet?: { start: string; end: string }): boolean {
  if (!quiet) return false;
  const hhmm = new Intl.DateTimeFormat('en-US', { timeZone: tz || 'America/Chicago', hour: '2-digit', minute: '2-digit', hour12: false }).format(new Date());
  const [h = 0, m = 0] = hhmm.split(':').map(Number);
  const now = h * 60 + m;
  const [sh = 0, sm = 0] = quiet.start.split(':').map(Number);
  const [eh = 0, em = 0] = quiet.end.split(':').map(Number);
  const start = sh * 60 + sm;
  const end = eh * 60 + em;
  return start > end ? now >= start || now < end : now >= start && now < end;
}

/** Enroll a lead and schedule every step. Marks first_contact_at so it is not re-enrolled. */
export async function enroll(orgId: string, leadId: string): Promise<void> {
  if (active.has(leadId)) return;
  const lead = await prisma.leads.findUnique({ where: { id: leadId } });
  if (!lead || lead.dnc_status || lead.automation_paused) return;

  // Claim atomically: only the caller that flips first_contact_at from null wins.
  // This closes the race where ingestion and the poll watcher both enroll the
  // same fresh lead (both would otherwise pass the in-memory active.has check).
  const claim = await prisma.leads.updateMany({ where: { id: leadId, first_contact_at: null }, data: { first_contact_at: new Date() } });
  if (claim.count === 0) return;

  const strategy = await getStrategy(orgId);
  const org = await prisma.organizations.findUnique({ where: { id: orgId }, select: { name: true, timezone: true } });
  const brokerage = org?.name ?? 'our team';
  const tz = org?.timezone ?? 'America/Chicago';

  const enrollment: Enrollment = { orgId, leadId, voiceAttempts: 0, timers: [], stopped: false };
  active.set(leadId, enrollment);
  log(`enrolled lead ${leadId} (${lead.first_name ?? ''}) into "${strategy.name}" — ${strategy.steps.length} steps`);

  const enrolledAt = Date.now();
  for (const step of strategy.steps) {
    const t = setTimeout(() => { void fireStep(enrollment, step, brokerage, tz, strategy.guardrails); }, Math.max(0, enrolledAt + offsetMs(step.after) - Date.now()));
    if (t.unref) t.unref();
    enrollment.timers.push(t);
  }
}

async function fireStep(e: Enrollment, step: StrategyStep, brokerage: string, tz: string, guardrails: any): Promise<void> {
  if (e.stopped) return;
  const lead = await prisma.leads.findUnique({ where: { id: e.leadId } });
  if (!lead) return stop(e);
  if (lead.dnc_status || lead.automation_paused) { log(`stop lead ${e.leadId} (dnc/paused)`); return stop(e); }
  if (lead.status === 'qualified' || lead.status === 'booked') { log(`stop lead ${e.leadId} (${lead.status})`); return stop(e); }

  // Quiet-hours: defer to the next allowed window.
  if (guardrails?.respectQuietHours !== false && inQuietHours(tz, guardrails?.quietHours)) {
    const t = setTimeout(() => { void fireStep(e, step, brokerage, tz, guardrails); }, 15 * 60 * 1000);
    if (t.unref) t.unref();
    e.timers.push(t);
    log(`deferred ${step.channel} for lead ${e.leadId} (quiet hours)`);
    return;
  }

  const firstName = (lead.first_name ?? '').trim() || 'there';
  if (step.channel === 'sms') {
    const text = (step.message ?? '').replace(/\{\{firstName\}\}/g, firstName).replace(/\{\{brokerage\}\}/g, brokerage);
    try {
      const r: any = await sendSms(e.orgId, lead.phone ?? '', text);
      await activity.recordSms(e.orgId, e.leadId, text, true, r?.id); // -> message 'sent', lead 'contacted'
      log(`SMS sent to lead ${e.leadId}`);
    } catch (err) {
      await activity.recordSms(e.orgId, e.leadId, text, false); // -> message 'failed', lead unchanged
      log(`SMS FAILED for lead ${e.leadId}: ${(err as Error).message}`);
    }
  } else if (step.channel === 'voice') {
    if ((guardrails?.maxVoiceAttempts ?? 99) <= e.voiceAttempts) { log(`skip call (max attempts) lead ${e.leadId}`); return; }
    e.voiceAttempts += 1;
    try {
      const r: any = await placeCall(e.orgId, lead.phone ?? '', { leadId: e.leadId, orgId: e.orgId });
      await activity.startCall(e.orgId, e.leadId, r?.call_control_id); // -> voice_call 'ringing'; webhook sets the outcome
      log(`AI call dialed to lead ${e.leadId}`);
    } catch (err) {
      await activity.recordCallFailed(e.orgId, e.leadId); // -> voice_call 'failed'
      log(`call FAILED for lead ${e.leadId}: ${(err as Error).message}`);
    }
  }
}

function stop(e: Enrollment): void {
  e.stopped = true;
  e.timers.forEach(clearTimeout);
  active.delete(e.leadId);
}

/** Called when the AI call qualifies the lead — ends the strategy and records the temperature. */
export async function qualified(orgId: string, leadId: string, temperature: string, summary?: string): Promise<void> {
  await prisma.leads.update({ where: { id: leadId }, data: { status: 'qualified', temperature, ...(summary ? { ai_summary: summary } : {}) } });
  const e = active.get(leadId);
  if (e) stop(e);
  log(`lead ${leadId} qualified as ${temperature} — strategy stopped, handed off`);
}
