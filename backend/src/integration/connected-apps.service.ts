import { Injectable } from '@nestjs/common';
import { CrmSyncRunStatus, IntegrationStatus, type CalendarProvider, type IntegrationProvider } from '@prisma/client';
import type { AuthContext } from '@/auth/auth.types';
import { inUse } from '@/calendar/connection/connection-state';
import { PrismaService } from '@/common/prisma/prisma.service';
import { PERMISSIONS } from '@/role/permissions';

/** connected: working. needs_reconnect: the app stopped accepting us; someone has to sign in again. error: it fails for another reason. syncing: a sync is running now. */
export type AppState = 'connected' | 'needs_reconnect' | 'error' | 'syncing';

export interface ConnectedApp {
  /** The connection row; stable for the UI's list keys. */
  id: string;
  provider: string;
  label: string;
  /** The account it is connected to, for people who may see integrations. */
  account: string | null;
  state: AppState;
  lastSyncAt: string | null;
  /** What is wrong and what it stops, in plain words; null when connected. */
  message: string | null;
  /** Only what a broken connection stops, for places that already say it is broken; null when connected. */
  impact: string | null;
  /** The app page where it is fixed. */
  reconnectPath: string;
}

export interface ConnectedAppsDTO {
  apps: ConnectedApp[];
  /** Whether this user may reconnect (integration.update); everyone sees the states. */
  canReconnect: boolean;
}

const LABEL: Record<IntegrationProvider, string> = {
  telnyx: 'Telnyx',
  tally: 'Tally',
  google: 'Google',
  typeform: 'Typeform',
  hubspot: 'HubSpot',
  airtable: 'Airtable',
  retell: 'Retell',
  boldtrail: 'BoldTrail',
  jotform: 'Jotform',
};

const CALENDAR_LABEL: Record<CalendarProvider, string> = { calendly: 'Calendly', cal: 'Cal.com' };

/** What a broken connection stops, in the words the owners' alert email uses. */
const IMPACT: Partial<Record<IntegrationProvider, string>> = {
  telnyx: 'AI calls and text messages to leads are failing.',
  google: 'New leads from Google Sheets and Forms are not being imported.',
  tally: 'New Tally form submissions are not reaching your lead sources.',
  typeform: 'New Typeform submissions are not reaching your lead sources.',
  jotform: 'New Jotform submissions are not reaching your lead sources.',
  hubspot: 'Leads are not syncing with HubSpot.',
  boldtrail: 'Leads are not syncing with BoldTrail.',
  airtable: 'Leads are not syncing with Airtable.',
};
const CALENDAR_IMPACT = 'Leads cannot book meetings, and availability and meetings are not syncing.';

/** CRMs whose lead sources run sync jobs. */
const SYNCED: IntegrationProvider[] = ['hubspot', 'boldtrail'];

const iso = (d: Date | null | undefined): string | null => (d ? d.toISOString() : null);
const latest = (...dates: (Date | null | undefined)[]): Date | null =>
  dates.reduce<Date | null>((a, d) => (d && (!a || d > a) ? d : a), null);

/**
 * Every app the office has connected, in one list, with whether it works. Connections live in three
 * places (integrations, the calendar connection in use, and CRM sync runs); this merges them so the
 * sidebar, the activity panel and the assistant all say the same thing.
 */
@Injectable()
export class ConnectedAppsService {
  constructor(private readonly prisma: PrismaService) {}

  async list(auth: AuthContext): Promise<ConnectedAppsDTO> {
    const orgId = auth.organizationId;
    const showAccount = auth.permissions.includes(PERMISSIONS.INTEGRATION_READ);
    const [integrations, calendar] = await Promise.all([
      this.prisma.integration.findMany({
        where: { orgId, revokedAt: null, status: { in: [IntegrationStatus.active, IntegrationStatus.invalid] } },
        orderBy: { createdAt: 'asc' },
        select: { id: true, provider: true, status: true, label: true, accountEmail: true, accountName: true, phoneNumber: true, lastVerifiedAt: true, lastErrorAt: true, lastErrorCode: true },
      }),
      this.prisma.calendarConnection.findFirst({
        where: inUse(orgId),
        select: { id: true, provider: true, status: true, accountEmail: true, accountName: true, lastError: true, syncError: true, meetingsError: true, syncedAt: true, meetingsSyncedAt: true },
      }),
    ]);
    const runs = await this.lastRuns(orgId, integrations.filter((i) => SYNCED.includes(i.provider)).map((i) => i.id));

    const apps: ConnectedApp[] = integrations.map((i) => {
      const run = runs.get(i.id);
      const impact = IMPACT[i.provider] ?? null;
      let state: AppState = 'connected';
      let message: string | null = null;
      if (i.status === IntegrationStatus.invalid || (i.provider === 'telnyx' && i.lastErrorCode)) {
        state = 'needs_reconnect';
        message = `${LABEL[i.provider]} stopped accepting the connection. ${impact ?? ''}`.trim();
      } else if (run?.status === CrmSyncRunStatus.running || run?.status === CrmSyncRunStatus.queued) {
        state = 'syncing';
      } else if (run?.status === CrmSyncRunStatus.failed) {
        state = 'error';
        message = `The last sync failed${run.errorMessage ? `: ${run.errorMessage}` : ''}.`;
      }
      return {
        id: i.id,
        provider: i.provider,
        label: LABEL[i.provider],
        account: showAccount ? (i.label || i.accountEmail || i.accountName || i.phoneNumber || null) : null,
        state,
        lastSyncAt: iso(latest(run?.finishedAt, i.lastVerifiedAt)),
        message,
        impact: state === 'connected' || state === 'syncing' ? null : state === 'needs_reconnect' ? impact : message,
        reconnectPath: i.provider === 'telnyx' ? '/settings?tab=telnyx' : '/integrations',
      };
    });

    if (calendar) {
      const label = CALENDAR_LABEL[calendar.provider];
      const syncProblem = calendar.syncError ?? calendar.meetingsError;
      apps.push({
        id: calendar.id,
        provider: calendar.provider,
        label,
        account: showAccount ? (calendar.accountEmail ?? calendar.accountName ?? null) : null,
        state: calendar.status === 'error' ? 'needs_reconnect' : syncProblem ? 'error' : 'connected',
        lastSyncAt: iso(latest(calendar.syncedAt, calendar.meetingsSyncedAt)),
        message:
          calendar.status === 'error'
            ? `${label} stopped accepting the connection. ${CALENDAR_IMPACT}`
            : syncProblem
              ? `Syncing with ${label} is failing: ${syncProblem}`
              : null,
        impact: calendar.status === 'error' ? CALENDAR_IMPACT : syncProblem ? `Syncing with ${label} is failing: ${syncProblem}` : null,
        reconnectPath: '/settings?tab=calendar',
      });
    }

    return { apps, canReconnect: auth.permissions.includes(PERMISSIONS.INTEGRATION_UPDATE) };
  }

  /** The newest sync run of each CRM connection, through the lead sources that use it. */
  private async lastRuns(orgId: string, integrationIds: string[]) {
    const out = new Map<string, { status: CrmSyncRunStatus; errorMessage: string | null; finishedAt: Date | null }>();
    if (integrationIds.length === 0) return out;
    const runs = await this.prisma.crmSyncRun.findMany({
      where: { orgId, leadSource: { integrationId: { in: integrationIds } } },
      orderBy: { createdAt: 'desc' },
      take: 50,
      select: { status: true, errorMessage: true, finishedAt: true, leadSource: { select: { integrationId: true } } },
    });
    for (const r of runs) {
      const id = r.leadSource.integrationId;
      if (id && !out.has(id)) out.set(id, { status: r.status, errorMessage: r.errorMessage, finishedAt: r.finishedAt });
    }
    return out;
  }
}
