import { BadRequestException, Injectable } from '@nestjs/common';
import { CalendarConnectionService } from '@/calendar/connection/calendar-connection.service';
import { CalendlyClient } from '@/calendar/providers/calendly.client';
import { NangoError, NangoService } from '../../nango/nango.service';
import type { AccountIdentity, AdapterContext, AdapterSetup, IntegrationAdapter, SetupResource } from '../adapter.interface';
import { CalendarAdapterBase, type CalendarSettings } from '../calendar-adapter.base';

/** Nango's catalog name for Calendly (OAuth 2). */
export const CALENDLY_PROVIDER = 'calendly';

/** A Calendly organization URI, as Calendly's API returns it. */
const ORGANIZATION_URI = /^https:\/\/api\.calendly\.com\/organizations\/[A-Za-z0-9-]{1,64}$/;

/**
 * Calendly as the organization's calendar, connected through Nango.
 *
 * Nango runs Calendly's OAuth consent, stores the tokens and refreshes them
 * (Calendly access tokens last two hours). This adapter confirms the account
 * is an owner or admin of its Calendly organization and hands the connection
 * to the calendar module, which does availability, booking (including the AI
 * assistant on live calls), meeting sync and Calendly webhooks. EstatePulse
 * never stores a Calendly token.
 *
 * One calendar books for an organization at a time; choosing Calendly here
 * switches a Cal.com calendar in use off (it is kept, and can be chosen again).
 */
@Injectable()
export class CalendlyAdapter extends CalendarAdapterBase implements IntegrationAdapter {
  protected readonly label = 'Calendly';

  readonly provider = CALENDLY_PROVIDER;
  readonly displayName = 'Calendly';
  readonly description =
    'Book meetings straight into Calendly, including while the AI assistant is on a call with a lead. Availability and booked meetings stay in sync.';
  readonly features = [
    'The AI assistant books meetings into Calendly during live calls',
    'Reads the availability of every member of your Calendly organization',
    'Booked and cancelled meetings stay in sync with EstatePulse',
    'Sign in with Calendly; tokens are kept and refreshed by Nango, never stored by EstatePulse',
  ];
  readonly capabilities = ['calendar', 'booking'] as const;
  readonly fallbackCategories = ['productivity'];
  /**
   * Calendly OAuth apps are granted their access when registered in Calendly's
   * developer portal; the Nango integration requests no scopes of its own.
   */
  readonly requiredScopes: readonly string[] = [];
  readonly leadSourceProvider = null;

  constructor(
    nango: NangoService,
    private readonly calendly: CalendlyClient,
    calendar: CalendarConnectionService,
  ) {
    super(nango, calendar, CalendlyAdapter.name);
  }

  async identify(ctx: AdapterContext): Promise<AccountIdentity> {
    const account = await this.withSecret(ctx, (token) => this.calendly.currentUser(token));
    return {
      accountName: account.name,
      accountEmail: account.email,
      externalAccountId: account.id,
      metadata: { timezone: account.timezone, schedulingUrl: account.schedulingUrl },
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

    state: (raw) => this.calendarState(raw, 'Confirm that meetings are booked into your Calendly organization.', () => 'Books into your Calendly organization'),

    listResources: async (ctx, kind): Promise<SetupResource[]> => {
      if (kind !== 'workspaces') return [];
      const { workspaces } = await this.withSecret(ctx, (token) => this.calendar.calendlyWorkspaces(token));
      return workspaces.map((w) => ({ id: w.id, name: w.name, detail: { type: w.type, slug: w.slug } }));
    },

    saveSettings: async (ctx, input): Promise<Record<string, unknown>> => {
      const workspaceId = typeof input.workspaceId === 'string' ? input.workspaceId.trim() : '';
      if (!ORGANIZATION_URI.test(workspaceId)) throw new BadRequestException('Choose your Calendly organization.');
      const workspace = await this.withSecret(ctx, (accessToken) =>
        this.calendar.useNangoCalendly(ctx.orgId, ctx.actorId, { ref: this.ref(ctx), accessToken, workspaceId }),
      );
      const settings: CalendarSettings = { workspaceId: workspace.id, workspaceName: workspace.name, workspaceType: workspace.type };
      return settings as Record<string, unknown>;
    },
  };
}
