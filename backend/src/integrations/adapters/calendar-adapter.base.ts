import { BadRequestException, ForbiddenException, HttpException, Logger } from '@nestjs/common';
import type { CalendarConnectionService } from '@/calendar/connection/calendar-connection.service';
import type { NangoReference } from '@/calendar/connection/nango-reference';
import { ProviderHttpError } from '@/calendar/providers/provider-http';
import { NangoError, type NangoService } from '../nango/nango.service';
import type { AdapterContext, AdapterLifecycle, SetupState } from './adapter.interface';

/** What a calendar adapter stores as its setup: the calendar it books into. */
export interface CalendarSettings {
  workspaceId?: string;
  workspaceName?: string;
  workspaceType?: string;
}

/**
 * Shared by the adapters that hand their Nango connection to the calendar
 * module (Cal.com, Calendly) instead of importing leads. The calendar module's
 * existing clients call the provider directly with the credential Nango holds,
 * so their errors (ProviderHttpError) are translated here into what the
 * marketplace understands.
 */
export abstract class CalendarAdapterBase {
  protected abstract readonly label: string;
  protected readonly logger: Logger;

  protected constructor(
    protected readonly nango: NangoService,
    protected readonly calendar: CalendarConnectionService,
    loggerName: string,
  ) {
    this.logger = new Logger(loggerName);
  }

  readonly lifecycle: AdapterLifecycle = {
    beforeDisconnect: (ctx) => this.calendar.releaseNangoWebhook(ctx.orgId, this.ref(ctx)),
    disconnected: (ctx) => this.calendar.forgetNango(ctx.orgId, this.ref(ctx)),
    accessLost: (ctx, reason) => this.calendar.nangoBroken(ctx.orgId, this.ref(ctx), reason),
    accessRestored: (ctx) => this.calendar.nangoRestored(ctx.orgId, this.ref(ctx)),
  };

  protected calendarState(raw: Record<string, unknown>, missing: string, summary: (s: CalendarSettings) => string): SetupState {
    const settings = raw as CalendarSettings;
    if (!settings.workspaceId) return { complete: false, missing, summary: null };
    return { complete: true, missing: null, summary: summary(settings) };
  }

  protected ref(ctx: AdapterContext): NangoReference {
    return { providerConfigKey: ctx.client.providerConfigKey, connectionId: ctx.client.nangoConnectionId };
  }

  /** The API key or access token Nango holds (refreshed by Nango when expired). */
  protected secret(ctx: AdapterContext, forceRefresh = false): Promise<string> {
    return this.nango.secretOf(ctx.client.providerConfigKey, ctx.client.nangoConnectionId, forceRefresh);
  }

  /**
   * Runs a provider call with the connection's credential. A rejected
   * credential is retried once with a fresh one from Nango (an OAuth token
   * can be refused just before Nango would refresh it), then reported as
   * "reconnect". A 401 means the provider did nothing, so repeating is safe.
   */
  protected async withSecret<T>(ctx: AdapterContext, run: (secret: string) => Promise<T>): Promise<T> {
    try {
      try {
        return await run(await this.secret(ctx));
      } catch (error) {
        if (!(error instanceof ProviderHttpError && error.credentialRejected)) throw error;
        this.nango.forgetApiKey(ctx.client.providerConfigKey, ctx.client.nangoConnectionId);
        return await run(await this.secret(ctx, true));
      }
    } catch (error) {
      throw this.translate(ctx, error);
    }
  }

  private translate(ctx: AdapterContext, error: unknown): unknown {
    if (error instanceof HttpException || error instanceof NangoError) return error;
    if (!(error instanceof ProviderHttpError)) return error;
    if (error.credentialRejected) {
      this.nango.forgetApiKey(ctx.client.providerConfigKey, ctx.client.nangoConnectionId);
      return new NangoError('REAUTH', `${this.label} rejected the credentials`, 401);
    }
    if (error.rateLimited) {
      return new NangoError('RATE_LIMITED', `${this.label} is rate limiting`, 429, error.retryAfterMs ? Math.ceil(error.retryAfterMs / 1000) : null);
    }
    if (error.status === 0 || error.status >= 500) return new NangoError('UNAVAILABLE', error.message, error.status || 503);
    this.logger.warn(`${this.label} refused a request: ${error.message} (HTTP ${error.status})`);
    if (error.status === 403) {
      return new ForbiddenException(`This ${this.label} account is not allowed to do that. Connect an account that is an owner or admin.`);
    }
    return new BadRequestException(error.message);
  }
}
