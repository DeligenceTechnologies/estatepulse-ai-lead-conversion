import { Inject, Injectable } from '@nestjs/common';
import { LeadStatus, type Prisma } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { ConnectedAppsService } from '@/integration/connected-apps.service';
import { OUTSIDE_IMPORT_REVIEW, fullName, visibleLeads } from '@/lead/lead-scope';
import { PERMISSIONS } from '@/role/permissions';

const DAY_MS = 24 * 60 * 60 * 1000;
export const ACTIVITY_PAGE = 30;
const MAX_HOURS = 72;

export type ActivityKind =
  | 'replied'
  | 'interested'
  | 'meeting_requested'
  | 'not_interested'
  | 'wrong_number'
  | 'opted_out'
  | 'callback'
  | 'takeover'
  | 'outreach_paused'
  | 'outreach_resumed'
  | 'meeting_booked'
  | 'meeting_canceled'
  | 'sync_done'
  | 'sync_failed';

export interface ActivityItem {
  /** Unique across sources, for list keys. */
  id: string;
  kind: ActivityKind;
  at: string;
  /** One plain line, without the lead's name (the UI shows it beside). */
  text: string;
  lead: { id: string; name: string } | null;
  tone: 'good' | 'bad' | 'neutral';
  /** For a meeting: when it is (or was) set for. */
  meetingAt?: string;
}

export interface NeedsYouItem {
  actionId: string;
  threadId: string;
  title: string;
  createdAt: string;
  expiresAt: string | null;
}

export interface ActivityAlert {
  app: string;
  state: 'needs_reconnect' | 'error';
  message: string | null;
  reconnectPath: string;
}

export interface ActivityFeed {
  /** Approval cards waiting on this user, newest first. */
  needsYou: NeedsYouItem[];
  /** Broken connections; everyone sees them, `canReconnect` says who may fix them. */
  alerts: ActivityAlert[];
  canReconnect: boolean;
  items: ActivityItem[];
  /** Pass as `before` for the next page; null when this was the last. */
  nextCursor: string | null;
}

/** Status moves worth telling the office about; the strategy's own new to contacting moves are not. */
const STATUS_KIND: Partial<Record<LeadStatus, { kind: ActivityKind; text: string; tone: ActivityItem['tone'] }>> = {
  [LeadStatus.engaged]: { kind: 'replied', text: 'replied and is talking with the AI', tone: 'good' },
  [LeadStatus.interested]: { kind: 'interested', text: 'is interested', tone: 'good' },
  [LeadStatus.appointment_requested]: { kind: 'meeting_requested', text: 'wants a meeting', tone: 'good' },
  [LeadStatus.not_interested]: { kind: 'not_interested', text: 'is not interested', tone: 'neutral' },
  [LeadStatus.invalid]: { kind: 'wrong_number', text: 'was marked a wrong number', tone: 'bad' },
};

const EVENT_TYPES = ['status_changed', 'opted_out', 'callback_scheduled', 'chat_taken_over', 'outreach_paused', 'outreach_resumed'];

const LEAD_NAME = { id: true, firstName: true, lastName: true } satisfies Prisma.LeadSelect;
const nameOf = (l: { id: string; firstName: string | null; lastName: string | null }) => ({ id: l.id, name: fullName(l.firstName, l.lastName, 'A lead') });

/**
 * The office's recent activity for the Activity panel and the assistant, built at read time from
 * tables we already keep: lead events, calendar meetings and CRM sync runs, plus the approval cards
 * waiting on this user and any broken connection. Every item about a lead goes through
 * visibleLeads, so an agent sees only their own leads. CRM syncs show to people who may see
 * integrations. Newest first, a page at a time, within the last 24 hours by default.
 */
@Injectable()
export class AssistantActivityService {
  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly apps: ConnectedAppsService,
  ) {}

  async feed(auth: AuthContext, opts: { before?: Date; hours?: number; limit?: number } = {}): Promise<ActivityFeed> {
    const orgId = auth.organizationId;
    const now = new Date();
    const hours = Math.min(Math.max(opts.hours ?? 24, 1), MAX_HOURS);
    const since = new Date(now.getTime() - (hours / 24) * DAY_MS);
    const before = opts.before && opts.before < now ? opts.before : now;
    const limit = Math.min(opts.limit ?? ACTIVITY_PAGE, ACTIVITY_PAGE);
    const window = { gte: since, lt: before };
    const leadScope: Prisma.LeadWhereInput = { ...visibleLeads(auth), ...OUTSIDE_IMPORT_REVIEW };

    const [events, booked, canceled, runs, cards, connections] = await Promise.all([
      this.prisma.leadEvent.findMany({
        where: { orgId, type: { in: EVENT_TYPES }, createdAt: window, lead: leadScope },
        orderBy: { createdAt: 'desc' },
        take: limit * 3,
        select: { id: true, type: true, toStatus: true, reason: true, actorType: true, actorId: true, payload: true, createdAt: true, lead: { select: LEAD_NAME } },
      }),
      this.prisma.calendarMeeting.findMany({
        where: { orgId, status: { in: ['scheduled', 'pending'] }, createdAt: window, lead: leadScope },
        orderBy: { createdAt: 'desc' },
        take: limit,
        select: { id: true, startsAt: true, createdAt: true, bookedVia: true, hostUser: { select: { firstName: true, lastName: true } }, lead: { select: LEAD_NAME } },
      }),
      this.prisma.calendarMeeting.findMany({
        where: { orgId, status: 'canceled', updatedAt: window, lead: leadScope },
        orderBy: { updatedAt: 'desc' },
        take: limit,
        select: { id: true, startsAt: true, updatedAt: true, lead: { select: LEAD_NAME } },
      }),
      auth.permissions.includes(PERMISSIONS.INTEGRATION_READ)
        ? this.prisma.crmSyncRun.findMany({
            where: { orgId, status: { in: ['succeeded', 'failed'] }, finishedAt: window },
            orderBy: { finishedAt: 'desc' },
            take: limit,
            select: { id: true, provider: true, status: true, created: true, updated: true, errorMessage: true, finishedAt: true },
          })
        : Promise.resolve([]),
      this.prisma.assistantAction.findMany({
        where: { orgId, userId: auth.userId, tier: 'write', status: 'proposed', OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
        orderBy: { createdAt: 'desc' },
        take: 10,
        select: { id: true, threadId: true, toolName: true, preview: true, createdAt: true, expiresAt: true },
      }),
      opts.before ? Promise.resolve(null) : this.apps.list(auth),
    ]);

    const people = await this.names(orgId, events.flatMap((e) => (e.actorType === 'user' && e.actorId ? [e.actorId] : [])));
    const items: ActivityItem[] = [];

    for (const e of events) {
      const lead = nameOf(e.lead);
      const at = e.createdAt.toISOString();
      const by = e.actorId ? people.get(e.actorId) : undefined;
      if (e.type === 'status_changed') {
        const s = e.toStatus ? STATUS_KIND[e.toStatus] : undefined;
        if (s) items.push({ id: `ev:${e.id}`, kind: s.kind, at, text: s.text, lead, tone: s.tone });
      } else if (e.type === 'opted_out') {
        items.push({ id: `ev:${e.id}`, kind: 'opted_out', at, text: 'asked not to be contacted', lead, tone: 'bad' });
      } else if (e.type === 'callback_scheduled') {
        items.push({ id: `ev:${e.id}`, kind: 'callback', at, text: 'asked for a callback', lead, tone: 'good' });
      } else if (e.type === 'chat_taken_over') {
        items.push({ id: `ev:${e.id}`, kind: 'takeover', at, text: `text chat taken over${by ? ` by ${by}` : ''}`, lead, tone: 'neutral' });
      } else if (e.type === 'outreach_paused') {
        items.push({ id: `ev:${e.id}`, kind: 'outreach_paused', at, text: `outreach paused${by ? ` by ${by}` : ''}${e.reason ? `: ${e.reason}` : ''}`, lead, tone: 'neutral' });
      } else if (e.type === 'outreach_resumed') {
        items.push({ id: `ev:${e.id}`, kind: 'outreach_resumed', at, text: `outreach resumed${by ? ` by ${by}` : ''}`, lead, tone: 'neutral' });
      }
    }
    for (const m of booked) {
      if (!m.lead) continue;
      const host = m.hostUser ? fullName(m.hostUser.firstName, m.hostUser.lastName) : null;
      items.push({
        id: `mb:${m.id}`,
        kind: 'meeting_booked',
        at: m.createdAt.toISOString(),
        text: `booked a meeting${host ? ` with ${host}` : ''}`,
        lead: nameOf(m.lead),
        tone: 'good',
        meetingAt: m.startsAt.toISOString(),
      });
    }
    for (const m of canceled) {
      if (!m.lead) continue;
      items.push({ id: `mc:${m.id}`, kind: 'meeting_canceled', at: m.updatedAt.toISOString(), text: 'canceled their meeting', lead: nameOf(m.lead), tone: 'bad', meetingAt: m.startsAt.toISOString() });
    }
    for (const r of runs) {
      const app = r.provider === 'HUBSPOT' ? 'HubSpot' : r.provider === 'BOLDTRAIL' ? 'BoldTrail' : r.provider.toLowerCase();
      if (r.status === 'failed') {
        items.push({ id: `sync:${r.id}`, kind: 'sync_failed', at: r.finishedAt!.toISOString(), text: `${app} sync failed${r.errorMessage ? `: ${r.errorMessage}` : ''}`, lead: null, tone: 'bad' });
      } else if (r.created + r.updated > 0) {
        items.push({ id: `sync:${r.id}`, kind: 'sync_done', at: r.finishedAt!.toISOString(), text: `${app} sync: ${r.created} new, ${r.updated} updated`, lead: null, tone: 'neutral' });
      }
    }

    // A source cut off at its take may hold more before its oldest row: the page stops there, so
    // the next page (before the page's last item) misses nothing from it.
    const cutoffs = [
      events.length === limit * 3 ? events.at(-1)!.createdAt : null,
      booked.length === limit ? booked.at(-1)!.createdAt : null,
      canceled.length === limit ? canceled.at(-1)!.updatedAt : null,
      runs.length === limit ? runs.at(-1)!.finishedAt : null,
    ].filter((d): d is Date => d !== null);
    const floor = cutoffs.length ? new Date(Math.max(...cutoffs.map((d) => d.getTime()))).toISOString() : null;
    const kept = (floor ? items.filter((i) => i.at >= floor) : items).sort((a, b) => b.at.localeCompare(a.at));
    const page = kept.slice(0, limit);
    const more = kept.length > limit || floor !== null;
    return {
      needsYou: cards.map((c) => ({
        actionId: c.id,
        threadId: c.threadId,
        title: (c.preview as { title?: string } | null)?.title ?? c.toolName,
        createdAt: c.createdAt.toISOString(),
        expiresAt: c.expiresAt?.toISOString() ?? null,
      })),
      alerts: (connections?.apps ?? [])
        .filter((a): a is typeof a & { state: 'needs_reconnect' | 'error' } => a.state === 'needs_reconnect' || a.state === 'error')
        .map((a) => ({ app: a.label, state: a.state, message: a.impact, reconnectPath: a.reconnectPath })),
      canReconnect: connections?.canReconnect ?? auth.permissions.includes(PERMISSIONS.INTEGRATION_UPDATE),
      items: page,
      nextCursor: more && page.length > 0 ? page[page.length - 1].at : null,
    };
  }

  private async names(orgId: string, ids: string[]): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const users = await this.prisma.user.findMany({ where: { orgId, id: { in: [...new Set(ids)] } }, select: { id: true, firstName: true, lastName: true, email: true } });
    return new Map(users.map((u) => [u.id, fullName(u.firstName, u.lastName, u.email)]));
  }
}
