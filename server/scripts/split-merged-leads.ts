/**
 * One-off reconciliation for leads that were merged before ingestion stopped
 * merging.
 *
 * Until migration 20260916000003 a submission whose phone matched an existing
 * lead was folded into that lead: its answers overwrote the earlier prospect's
 * location, timeline and budget, and the person who actually sent it never
 * appeared in the pipeline. Ingestion no longer does this — see
 * ProcessingWorker.createLead — but leads created under the old rule are still
 * collapsed, and their screens still under-report how many people asked to be
 * contacted.
 *
 * Nothing was lost: `lead_submissions` kept every submission's own
 * `mapped_values` and `normalized_answers`. This script replays that record
 * into the shape ingestion would produce today — the first submission keeps the
 * existing lead (and its id, so conversations and appointments stay attached),
 * every later one gets a lead of its own.
 *
 * Dry run by default. Nothing is written without --apply.
 *
 *   npx tsx scripts/split-merged-leads.ts            # show what would change
 *   npx tsx scripts/split-merged-leads.ts --apply    # do it
 */
import { PrismaClient } from '@prisma/client';
import { newId } from '../src/common/ids';

const prisma = new PrismaClient();
const APPLY = process.argv.includes('--apply');

type Values = Record<string, unknown>;

const str = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const int = (v: unknown) => {
  const n = num(v);
  return n === null ? null : Math.round(n);
};

/**
 * Rebuild the answers that never reached a typed column.
 *
 * `unmapped_keys` holds LABELS (that is what `custom_fields` is keyed by), and
 * `normalized_answers` still holds each label's text, so the pair reconstructs
 * exactly what this submission alone contributed. The `(unvalidated)` suffix is
 * what the worker appends to an answer that failed validation, so it is stripped
 * to find the answer and kept in the rebuilt key.
 */
function customFieldsOf(answers: unknown, unmappedKeys: string[]): Record<string, string> {
  const list = Array.isArray(answers) ? (answers as { label?: string; scalarText?: string }[]) : [];
  const byLabel = new Map(list.map((a) => [a.label ?? '', a.scalarText ?? '']));
  const out: Record<string, string> = {};
  for (const key of unmappedKeys) {
    const text = byLabel.get(key) ?? byLabel.get(key.replace(/ \(unvalidated\)$/, ''));
    if (text) out[key] = text;
  }
  return out;
}

/** The columns the merge policy could overwrite — and only those. */
function leadFieldsFrom(values: Values, customFields: Record<string, string>) {
  const phone = str(values.phone);
  const email = str(values.email);
  const normalizedPhone = phone && phone.startsWith('+') ? phone : null;
  // Same rule as the worker: an address that is not shaped like one is stored
  // but never keys identity.
  const emailValid = !!email && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.toLowerCase());
  const reviewReasons =
    phone && !normalizedPhone
      ? ['Phone number could not be parsed — this lead must not be auto-dialled']
      : [];

  return {
    first_name: str(values.first_name),
    last_name: str(values.last_name),
    email,
    normalized_email: emailValid ? email!.toLowerCase() : null,
    phone,
    normalized_phone: normalizedPhone,
    phone_valid: Boolean(normalizedPhone),
    email_valid: emailValid,
    location: str(values.location),
    timeline: str(values.timeline),
    buying_intent: str(values.buying_intent),
    financing_status: str(values.financing_status),
    min_budget: num(values.min_budget),
    max_budget: num(values.max_budget),
    bedrooms: int(values.bedrooms),
    motivation: str(values.motivation),
    custom_fields: customFields as never,
    needs_review: reviewReasons.length > 0,
    review_reasons: reviewReasons,
    submission_count: 1,
  };
}

async function main(): Promise<void> {
  const merged = await prisma.leads.findMany({
    where: { leadSubmissions: { some: {} } },
    include: { leadSubmissions: { orderBy: [{ submitted_at: 'asc' }, { created_at: 'asc' }] } },
  });
  const targets = merged.filter((l) => l.leadSubmissions.length > 1);

  if (targets.length === 0) {
    console.log('No merged leads found — nothing to split.');
    return;
  }

  console.log(`${APPLY ? 'Splitting' : 'Would split'} ${targets.length} merged lead(s):\n`);
  let created = 0;

  for (const lead of targets) {
    const [first, ...rest] = lead.leadSubmissions;
    const name = `${lead.first_name ?? ''} ${lead.last_name ?? ''}`.trim() || lead.id.slice(0, 8);

    const keepFields = leadFieldsFrom(
      (first.mapped_values ?? {}) as Values,
      customFieldsOf(first.normalized_answers, first.unmapped_keys),
    );
    console.log(`  ${name}`);
    console.log(
      `    keeps submission 1 of ${lead.leadSubmissions.length}: ` +
        `${keepFields.first_name ?? '?'} ${keepFields.last_name ?? ''} <${keepFields.email ?? '-'}> ` +
        `location=${keepFields.location ?? '-'}`,
    );

    if (APPLY) {
      await prisma.leads.update({
        where: { id: lead.id },
        data: { ...keepFields, last_submission_at: first.submitted_at },
      });
      await prisma.lead_submissions.update({
        where: { id: first.id },
        data: { is_first_for_lead: true },
      });
    }

    for (const sub of rest) {
      const values = (sub.mapped_values ?? {}) as Values;
      const fields = leadFieldsFrom(values, customFieldsOf(sub.normalized_answers, sub.unmapped_keys));
      console.log(
        `    -> new lead: ${fields.first_name ?? '?'} ${fields.last_name ?? ''} ` +
          `<${fields.email ?? '-'}> location=${fields.location ?? '-'}`,
      );
      created++;
      if (!APPLY) continue;

      const consentGranted = values.consent_status === true;
      const source = await prisma.lead_sources.findUnique({
        where: { id: sub.lead_source_id },
        select: { default_consent_status: true },
      });
      const newLeadId = newId();

      await prisma.$transaction(async (tx) => {
        await tx.leads.create({
          data: {
            id: newLeadId,
            organization_id: sub.organization_id,
            lead_source_id: sub.lead_source_id,
            ...fields,
            status: 'new',
            temperature: 'cold',
            score: 0,
            consent_status: consentGranted ? 'granted' : (source?.default_consent_status ?? 'pending'),
            consent_source: consentGranted ? 'webhook_form' : null,
            consent_at: consentGranted ? sub.submitted_at : null,
            last_submission_at: sub.submitted_at,
            // The lead is backdated to when the prospect actually submitted, not
            // to when this script ran, or every split lead would look brand new
            // and jump to the top of a pipeline sorted by arrival.
            created_at: sub.submitted_at,
          },
        });
        await tx.lead_submissions.update({
          where: { id: sub.id },
          data: { lead_id: newLeadId, is_first_for_lead: true },
        });
        // Keep the Deliveries panel pointing at the lead this delivery produced.
        await tx.webhook_events.update({
          where: { id: sub.webhook_event_id },
          data: { lead_id: newLeadId },
        });
      });
    }
    console.log();
  }

  console.log(
    APPLY
      ? `Done. ${created} lead(s) recovered from merged submissions.`
      : `Dry run: ${created} lead(s) would be recovered. Re-run with --apply to write.`,
  );
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => void prisma.$disconnect());
