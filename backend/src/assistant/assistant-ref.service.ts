import { Inject, Injectable } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { AppError } from '@/common/errors/app-error';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { fullName, visibleLeads } from '@/lead/lead-scope';
import { formatRef, parseRef, refsInAnswer, type RefKind, type RefTable } from './tools/refs';

/** Two turns of one chat never run at once, so a clash on a number is rare; a few retries settle it. */
const MAX_ATTEMPTS = 3;

const NOT_FOUND: Record<RefKind, string> = {
  lead: 'is not a lead from this chat that this user can see. Find the lead with lead_search first.',
  user: 'is not a team member from this chat. Look them up with team_list first.',
  call: 'is not a call from this chat that this user can see. Find it with call_list first.',
  meeting: 'is not a meeting from this chat that this user can see. Find it with meeting_list first.',
  sequence: 'is not a sequence from this chat. Look it up with sequence_list first.',
  slot: 'is not a time offered in this chat. Get open times with meeting_slots first.',
};

@Injectable()
export class AssistantRefService {
  constructor(@Inject(TENANT_PRISMA) private readonly db: GuardedPrisma) {}

  /** The refs of one chat, for the user it belongs to. The caller has already checked the chat is theirs. */
  forThread(auth: AuthContext, threadId: string): RefTable {
    return new ThreadRefs(this.db, auth, threadId);
  }

  /**
   * The refs that answers in this chat name in brackets: a link for each lead the user may see
   * (the app turns its name into a link and hides the ref), and the refs this chat never issued,
   * which the model made up. A lead the user can no longer see gets no link and is not made up.
   */
  async inspect(auth: AuthContext, threadId: string, texts: string | readonly string[]): Promise<{ links: Record<string, RefLink>; madeUp: string[] }> {
    const named = refsInAnswer(typeof texts === 'string' ? texts : texts.join('\n'));
    if (named.length === 0) return { links: {}, madeUp: [] };
    const rows = await this.db.assistantRef.findMany({
      where: { threadId, OR: named.map(({ kind, number }) => ({ entityType: kind, number })) },
      select: { entityType: true, number: true, entityId: true },
    });
    const issued = new Map(rows.map((r) => [formatRef(r.entityType as RefKind, r.number), r]));
    const madeUp = named.filter((n) => !issued.has(n.ref)).map((n) => n.ref);

    const leadRefs = named.filter((n) => n.kind === 'lead' && issued.has(n.ref));
    const leads = leadRefs.length
      ? await this.db.lead.findMany({
          where: { id: { in: leadRefs.map((n) => issued.get(n.ref)!.entityId) }, ...visibleLeads(auth) },
          select: { id: true, firstName: true, lastName: true, email: true, phone: true },
        })
      : [];
    const byId = new Map(leads.map((l) => [l.id, l]));
    const links: Record<string, RefLink> = {};
    for (const n of leadRefs) {
      const lead = byId.get(issued.get(n.ref)!.entityId);
      if (lead) links[n.ref] = { kind: 'lead', id: lead.id, name: fullName(lead.firstName, lead.lastName) || lead.email || lead.phone || 'Lead' };
    }
    return { links, madeUp };
  }
}

/** A record an answer names, for the app to link to. Only leads for now. */
export interface RefLink {
  kind: 'lead';
  id: string;
  name: string;
}

class ThreadRefs implements RefTable {
  /** `${kind}:${id}` to ref, for refs already read or written in this request. */
  private readonly known = new Map<string, string>();

  constructor(
    private readonly db: GuardedPrisma,
    private readonly auth: AuthContext,
    private readonly threadId: string,
  ) {}

  async resolve(kind: RefKind, ref: string): Promise<string> {
    const number = parseRef(kind, ref);
    const row =
      number === null
        ? null
        : await this.db.assistantRef.findFirst({ where: { threadId: this.threadId, entityType: kind, number }, select: { entityId: true } });
    // Same answer for a ref never issued and a record the user can no longer see, so nothing leaks.
    if (!row || !(await this.visible(kind, row.entityId))) throw new AppError('NOT_FOUND', `${ref} ${NOT_FOUND[kind]}`);
    this.known.set(`${kind}:${row.entityId}`, ref);
    return row.entityId;
  }

  async issue(kind: RefKind, ids: readonly string[]): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    let missing: string[] = [];
    for (const id of new Set(ids)) {
      const ref = this.known.get(`${kind}:${id}`);
      if (ref) out.set(id, ref);
      else missing.push(id);
    }

    for (let attempt = 0; missing.length > 0; attempt++) {
      const rows = await this.db.assistantRef.findMany({
        where: { threadId: this.threadId, entityType: kind, entityId: { in: missing } },
        select: { entityId: true, number: true },
      });
      for (const r of rows) {
        const ref = formatRef(kind, r.number);
        this.known.set(`${kind}:${r.entityId}`, ref);
        out.set(r.entityId, ref);
      }
      missing = missing.filter((id) => !out.has(id));
      if (missing.length === 0) break;
      if (attempt === MAX_ATTEMPTS) throw new Error(`could not issue ${kind} refs in thread ${this.threadId}`);
      await this.allocate(kind, missing);
    }
    return out;
  }

  /** Numbers the records in the order given, after the highest number this chat has for the kind. */
  private async allocate(kind: RefKind, ids: string[]): Promise<void> {
    const top = await this.db.assistantRef.aggregate({ where: { threadId: this.threadId, entityType: kind }, _max: { number: true } });
    const next = (top._max.number ?? 0) + 1;
    // A row that clashes with one written meanwhile is skipped, and the next round numbers it again.
    await this.db.assistantRef.createMany({
      data: ids.map((entityId, i) => ({
        orgId: this.auth.organizationId,
        threadId: this.threadId,
        entityType: kind,
        entityId,
        number: next + i,
      })),
      skipDuplicates: true,
    });
  }

  /** Checked on every use: a lead reassigned or merged away since the ref was issued is gone for this user. */
  private async visible(kind: RefKind, id: string): Promise<boolean> {
    const orgId = this.auth.organizationId;
    switch (kind) {
      case 'lead':
        return (await this.db.lead.count({ where: { id, ...visibleLeads(this.auth) } })) > 0;
      case 'call':
        return (await this.db.call.count({ where: { id, orgId, lead: visibleLeads(this.auth) } })) > 0;
      case 'user':
        return (await this.db.user.count({ where: { id, orgId } })) > 0;
      case 'meeting':
        // A meeting with a lead they can see, or one they host.
        return (await this.db.calendarMeeting.count({ where: { id, orgId, OR: [{ lead: visibleLeads(this.auth) }, { hostUserId: this.auth.userId }] } })) > 0;
      case 'sequence':
        return (await this.db.sequence.count({ where: { id, orgId } })) > 0;
      case 'slot':
        // A start time, not a record: the booking tool checks it is still ahead and still open.
        return true;
    }
  }
}
