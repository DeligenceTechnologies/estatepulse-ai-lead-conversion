/**
 * Duplicates already in the database, from before leads were matched on arrival.
 *
 *   npm run build && node dist/scripts/backfill-duplicates.js                       # report only, writes nothing
 *   node dist/scripts/backfill-duplicates.js --scan                                  # fill the Duplicates review queue
 *   node dist/scripts/backfill-duplicates.js --scan --merge-exact-phone --yes        # also merge leads sharing a phone
 *   ... --org <organization id>                                                      # one organization only
 *
 * The original-source rows (lead_submissions.is_original) are written by the lead_dedup migration itself.
 * Merging uses LeadMergeService, so every merge is logged and can be undone from the lead. A phone shared by
 * more than MAX_GROUP leads (a placeholder or office number) is reported and never merged.
 *
 * Only the services it needs are constructed — not the app — so no poller, worker or cron starts.
 */
import 'dotenv/config';
import { AuditService } from '@/audit/audit.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { DuplicateScannerService } from '@/lead/duplicates/duplicate-scanner.service';
import { LeadMergeService } from '@/lead/duplicates/lead-merge.service';
import { pickSurvivor } from '@/lead/duplicates/merge-rules';
import { LeadStateService } from '@/lead/lead-state.service';

const MAX_GROUP = 10;

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const orgArg = args.includes('--org') ? args[args.indexOf('--org') + 1] : null;

async function main(): Promise<void> {
  const scan = flag('--scan') || flag('--merge-exact-phone');
  const merge = flag('--merge-exact-phone');
  if (merge && !flag('--yes')) {
    console.error('--merge-exact-phone changes leads; run without it first to see the groups, then add --yes.');
    process.exit(1);
  }

  const prisma = new PrismaService({ get: () => undefined } as never);
  await prisma.$connect();
  const audit = new AuditService(prisma);
  const state = new LeadStateService(prisma);
  const scanner = new DuplicateScannerService(prisma);
  const merges = new LeadMergeService(prisma, audit, state, new EventsBus());

  const orgs = orgArg ? [{ id: orgArg }] : await prisma.organization.findMany({ select: { id: true } });
  for (const org of orgs) {
    const groups = await prisma.lead.groupBy({
      by: ['normalizedPhone'],
      where: { orgId: org.id, mergedIntoId: null, normalizedPhone: { not: null } },
      _count: { _all: true },
      having: { normalizedPhone: { _count: { gt: 1 } } },
    });
    const emailGroups = await prisma.lead.groupBy({
      by: ['normalizedEmail'],
      where: { orgId: org.id, mergedIntoId: null, normalizedEmail: { not: null } },
      _count: { _all: true },
      having: { normalizedEmail: { _count: { gt: 1 } } },
    });
    const leadsInPhoneGroups = groups.reduce((n, g) => n + g._count._all, 0);
    console.log(
      `org ${org.id}: ${groups.length} phone(s) shared by ${leadsInPhoneGroups} leads; ${emailGroups.length} email(s) shared by ${emailGroups.reduce((n, g) => n + g._count._all, 0)} leads`,
    );

    if (scan) {
      const r = await scanner.scanOrg(org.id);
      console.log(`  review queue: ${r.added} added, ${r.dropped} dropped, ${r.open} open`);
    }
    if (!merge) continue;

    let merged = 0;
    for (const g of groups) {
      if (g._count._all > MAX_GROUP) {
        console.log(`  skipped ${g.normalizedPhone}: ${g._count._all} leads share it — too many to be one person`);
        continue;
      }
      const leads = await prisma.lead.findMany({
        where: { orgId: org.id, mergedIntoId: null, normalizedPhone: g.normalizedPhone },
        select: { id: true, status: true, createdAt: true, _count: { select: { calls: true, messages: true } } },
      });
      const facts = leads.map((l) => ({ id: l.id, status: l.status, createdAt: l.createdAt, activity: l._count.calls + l._count.messages }));
      const keep = facts.reduce((a, b) => (pickSurvivor(a, b).survivor === a.id ? a : b));
      for (const other of facts.filter((f) => f.id !== keep.id)) {
        try {
          await merges.merge(org.id, keep.id, other.id, { type: 'system' }, ['Same phone number (backfill)']);
          merged += 1;
        } catch (error) {
          console.log(`  could not merge ${other.id} into ${keep.id}: ${(error as Error).message}`);
        }
      }
    }
    console.log(`  merged ${merged} lead(s) into the lead kept for their phone`);
  }
  await prisma.$disconnect();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
