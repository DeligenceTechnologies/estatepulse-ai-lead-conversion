import { Injectable, Logger } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { nationalNumber, normalizePhone } from './identity';
import { type ScanLead, type ScoredPair, scorePairs } from './pair-scoring';

const SCAN_SELECT = { id: true, normalizedPhone: true, normalizedEmail: true } as const;
const CHUNK = 1_000;

/**
 * Finds leads that look like the same person and puts them in the review queue (DuplicateCandidate)
 * for someone to merge or dismiss. Suggests only — nothing here merges. Runs for one lead when it is
 * created or its phone/email changes, and for every organization nightly, which also catches what
 * existed before this was built and drops suggestions that no longer hold.
 */
@Injectable()
export class DuplicateScannerService {
  private readonly logger = new Logger(DuplicateScannerService.name);

  constructor(private readonly prisma: PrismaService) {}

  /** For bookkeeping that must never fail the work that triggered it. */
  scanLeadQuietly(orgId: string, leadId: string): void {
    this.scanLead(orgId, leadId).catch((error) => this.logger.warn(`duplicate scan of lead ${leadId}: ${(error as Error).message}`));
  }

  /** The suggestions for one lead: everyone sharing a key with it, scored against it. Returns the open pair count. */
  async scanLead(orgId: string, leadId: string): Promise<number> {
    const lead = await this.prisma.lead.findFirst({ where: { id: leadId, orgId, mergedIntoId: null }, select: SCAN_SELECT });
    if (!lead) return 0;
    const phone = normalizePhone(lead.normalizedPhone) ?? lead.normalizedPhone;
    const national = nationalNumber(phone);
    const local = lead.normalizedEmail?.split('@')[0]?.split('+')[0];
    const or: Prisma.LeadWhereInput[] = [
      ...(lead.normalizedPhone ? [{ normalizedPhone: lead.normalizedPhone }] : []),
      ...(phone && phone !== lead.normalizedPhone ? [{ normalizedPhone: phone }] : []),
      ...(national ? [{ normalizedPhone: { endsWith: national } }] : []),
      ...(lead.normalizedEmail ? [{ normalizedEmail: lead.normalizedEmail }] : []),
      ...(local ? [{ normalizedEmail: { startsWith: local.replace(/\./g, '').slice(0, 3) } }] : []),
    ];
    if (!or.length) return 0;
    const near = await this.prisma.lead.findMany({
      where: { orgId, mergedIntoId: null, id: { not: leadId }, OR: or },
      select: SCAN_SELECT,
      take: 200,
    });
    const pairs = scorePairs([lead, ...near], leadId);
    await this.save(orgId, pairs);
    return pairs.length;
  }

  /** Every pair in the organization; open suggestions that no longer match are dropped. */
  async scanOrg(orgId: string): Promise<{ open: number; added: number; dropped: number }> {
    const leads: ScanLead[] = [];
    let cursor: string | undefined;
    for (;;) {
      const page = await this.prisma.lead.findMany({
        where: { orgId, mergedIntoId: null, OR: [{ normalizedPhone: { not: null } }, { normalizedEmail: { not: null } }] },
        select: SCAN_SELECT,
        orderBy: { id: 'asc' },
        take: CHUNK,
        ...(cursor ? { skip: 1, cursor: { id: cursor } } : {}),
      });
      leads.push(...page);
      if (page.length < CHUNK) break;
      cursor = page[page.length - 1].id;
    }
    const pairs = scorePairs(leads);
    const added = await this.save(orgId, pairs);
    const keep = new Set(pairs.map((p) => `${p.leadAId}|${p.leadBId}`));
    const open = await this.prisma.duplicateCandidate.findMany({ where: { orgId, status: 'open' }, select: { id: true, leadAId: true, leadBId: true } });
    const stale = open.filter((c) => !keep.has(`${c.leadAId}|${c.leadBId}`)).map((c) => c.id);
    if (stale.length) await this.prisma.duplicateCandidate.deleteMany({ where: { id: { in: stale } } });
    return { open: open.length - stale.length + added, added, dropped: stale.length };
  }

  /** Nightly, for every organization. Upserts are idempotent, so two instances running it at once only repeat work. */
  @Cron('30 3 * * *')
  async scanAll(): Promise<void> {
    const orgs = await this.prisma.organization.findMany({ select: { id: true } });
    for (const org of orgs) {
      try {
        const r = await this.scanOrg(org.id);
        if (r.added || r.dropped) this.logger.log(`org ${org.id}: ${r.added} new duplicate suggestion(s), ${r.dropped} dropped, ${r.open} open`);
      } catch (error) {
        this.logger.warn(`duplicate scan of org ${org.id}: ${(error as Error).message}`);
      }
    }
  }

  /** New pairs are opened; an open pair gets its latest score; a merged or dismissed pair is left alone. Returns pairs added. */
  private async save(orgId: string, pairs: ScoredPair[]): Promise<number> {
    let added = 0;
    for (let i = 0; i < pairs.length; i += CHUNK) {
      const chunk = pairs.slice(i, i + CHUNK);
      const existing = await this.prisma.duplicateCandidate.findMany({
        where: { OR: chunk.map((p) => ({ leadAId: p.leadAId, leadBId: p.leadBId })) },
        select: { id: true, leadAId: true, leadBId: true, status: true, score: true, reasons: true },
      });
      const byPair = new Map(existing.map((c) => [`${c.leadAId}|${c.leadBId}`, c]));
      const fresh = chunk.filter((p) => !byPair.has(`${p.leadAId}|${p.leadBId}`));
      if (fresh.length) {
        const r = await this.prisma.duplicateCandidate.createMany({ data: fresh.map((p) => ({ orgId, ...p })), skipDuplicates: true });
        added += r.count;
      }
      for (const p of chunk) {
        const c = byPair.get(`${p.leadAId}|${p.leadBId}`);
        if (c?.status === 'open' && (c.score !== p.score || c.reasons.join('|') !== p.reasons.join('|'))) {
          await this.prisma.duplicateCandidate.update({ where: { id: c.id }, data: { score: p.score, reasons: p.reasons } });
        }
      }
    }
    return added;
  }
}
