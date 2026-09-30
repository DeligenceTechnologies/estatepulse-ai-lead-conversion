import { Injectable } from '@nestjs/common';
import { AppError } from '../../../common/errors';
import { CalComProvider } from './calcom.provider';
import { CalendlyProvider } from './calendly.provider';
import { HOST_ID_COLUMN, type CalendarProvider, type CalendarProviderId } from './types';

/**
 * Which adapter serves a given connection.
 *
 * One lookup, so a third provider is registered in exactly one place rather
 * than discovered by grepping for switch statements.
 */
@Injectable()
export class CalendarProviderRegistry {
  private readonly byId: Map<CalendarProviderId, CalendarProvider>;

  constructor(calendly: CalendlyProvider, calcom: CalComProvider) {
    this.byId = new Map<CalendarProviderId, CalendarProvider>([
      [calendly.id, calendly],
      [calcom.id, calcom],
    ]);
  }

  /** Every provider, for status screens that describe what could be connected. */
  all(): CalendarProvider[] {
    return [...this.byId.values()];
  }

  isKnown(provider: string): provider is CalendarProviderId {
    return this.byId.has(provider as CalendarProviderId);
  }

  /**
   * The adapter for a stored connection.
   *
   * Throws rather than returning null: a `calendar_connections` row whose
   * provider we do not recognise is a database we no longer understand, and
   * carrying on with a default would silently sync the wrong thing.
   */
  get(provider: string): CalendarProvider {
    const found = this.byId.get(provider as CalendarProviderId);
    if (!found) {
      throw new AppError('VALIDATION_ERROR', `Unsupported calendar provider "${provider}"`);
    }
    return found;
  }

  /**
   * Which `agent_profiles` column holds this provider's host identity.
   *
   * The indirection earns its place: `calendly_user_uri` is text and
   * `cal_user_id` is an integer, and every read and write of either goes
   * through here so no caller has to remember which is which.
   */
  hostColumn(provider: string): (typeof HOST_ID_COLUMN)[CalendarProviderId] {
    return HOST_ID_COLUMN[this.get(provider).id];
  }
}
