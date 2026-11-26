import { BadRequestException, Injectable } from '@nestjs/common';
import { CalClient } from '@/calendar/providers/cal.client';
import { CalendarConnectionService, PERSONAL_WORKSPACE } from '@/calendar/connection/calendar-connection.service';
import { NangoError, NangoService } from '../../nango/nango.service';
import type { AccountIdentity, AdapterContext, AdapterSetup, IntegrationAdapter, SetupResource } from '../adapter.interface';
import { CalendarAdapterBase, type CalendarSettings } from '../calendar-adapter.base';

/** Nango's catalog name for Cal.com's v2 API with an API key, the API EstatePulse's calendar module speaks. */
export const CAL_COM_PROVIDER = 'cal-com-v2';

/**
 * Cal.com as the organization's calendar, connected through Nango.
 *
 * Nango collects and stores the customer's Cal.com API key (Connect UI); this
 * adapter picks the calendar to book into and hands the connection to the
 * calendar module, which already does availability, booking (including the AI
 * assistant on live calls), meeting sync and Cal.com webhooks. The calendar
 * module reads the key from Nango when it calls Cal.com; EstatePulse never
 * stores it.
 *
 * One calendar books for an organization at a time. Connecting a second
 * account is allowed; choosing its calendar makes it the one in use.
 */
@Injectable()
export class CalComAdapter extends CalendarAdapterBase implements IntegrationAdapter {
  protected readonly label = 'Cal.com';

  readonly provider = CAL_COM_PROVIDER;
  readonly displayName = 'Cal.com';
  readonly description =
    'Book meetings straight into Cal.com, including while the AI assistant is on a call with a lead. Availability and booked meetings stay in sync.';
  readonly features = [
    'The AI assistant books meetings into Cal.com during live calls',
    'Reads the availability of your own calendar or of every member of a Cal.com team',
    'Booked, rescheduled and cancelled meetings stay in sync with EstatePulse',
    'Your Cal.com API key is kept by Nango, never stored by EstatePulse',
  ];
  readonly capabilities = ['calendar', 'booking'] as const;
  readonly fallbackCategories = ['productivity'];
  /** API-key auth: there are no OAuth scopes. The key's owner must be an owner or admin of a team to book for it. */
  readonly requiredScopes: readonly string[] = [];
  readonly leadSourceProvider = null;

  constructor(
    nango: NangoService,
    private readonly cal: CalClient,
    calendar: CalendarConnectionService,
  ) {
    super(nango, calendar, CalComAdapter.name);
  }

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    const account = await this.withSecret(ctx, (key) => this.cal.me(key));
    return {
      accountName: account.name ?? account.username,
      accountEmail: account.email,
      externalAccountId: account.id,
      metadata: { username: account.username, timezone: account.timezone },
    };
  }

  async validateConnection(ctx: AdapterContext): Promise<boolean> {
    try {
      await this.identify(ctx);
      return true;
    } catch (error) {
      if (error instanceof NangoError && error.kind === 'REAUTH') return false;
      throw error;
    }
  }

  readonly setup: AdapterSetup = {
    resourceKinds: ['workspaces'],

    state: (raw) =>
      this.calendarState(raw, 'Choose which Cal.com calendar meetings are booked into.', (s) =>
        s.workspaceType === 'team' ? `Books into team ${s.workspaceName ?? ''}`.trim() : 'Books into your own calendar',
      ),

    listResources: async (ctx, kind): Promise<SetupResource[]> => {
      if (kind !== 'workspaces') return [];
      const { workspaces } = await this.withSecret(ctx, (key) => this.calendar.calWorkspaces(key));
      return workspaces.map((w) => ({ id: w.id, name: w.name, detail: { type: w.type, slug: w.slug } }));
    },

    saveSettings: async (ctx, input): Promise<Record<string, unknown>> => {
      const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
      if (!workspaceId || workspaceId.length > 64 || !(workspaceId === PERSONAL_WORKSPACE || /^\d+$/.test(workspaceId))) {
        throw new BadRequestException('Choose your own calendar or one of your Cal.com teams.');
      }
      const workspace = await this.withSecret(ctx, (apiKey) =>
        this.calendar.useNangoCal(ctx.orgId, ctx.actorId, { ref: this.ref(ctx), apiKey, workspaceId }),
      );
      const settings: CalendarSettings = { workspaceId: workspace.id, workspaceName: workspace.name, workspaceType: workspace.type };
      return settings as Record<string, unknown>;
    },
  };
}
