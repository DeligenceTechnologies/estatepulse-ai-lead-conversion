import { Injectable } from '@nestjs/common';
import { AppError } from '../../common/errors';
import { CalendarConnectionsService } from './calendar-connections.service';
import { CalendarRosterService } from './calendar-roster.service';
import { CalendarProviderRegistry } from './providers/provider.registry';
import type { CalendarEventTypeDTO } from './types';

/**
 * The office's bookable pages.
 *
 * Read-only and not persisted. An event type belongs to the scheduling
 * provider, it changes whenever someone edits it there, and a copy here would
 * be a second source of truth that is wrong more often than it is right.
 *
 * The awkward part — Calendly's organization scope omits shared event types, so
 * round-robin pages are only reachable one member at a time — lives in the
 * Calendly adapter. All this does is hand it the roster it needs; Cal.com
 * ignores the argument and answers from its team endpoint in one request.
 */
@Injectable()
export class CalendarEventTypesService {
  constructor(
    private readonly providers: CalendarProviderRegistry,
    private readonly connections: CalendarConnectionsService,
    private readonly roster: CalendarRosterService,
  ) {}

  async list(organizationId: string): Promise<CalendarEventTypeDTO[]> {
    const conn = await this.connections.syncableOrgRow(organizationId);
    if (!conn) {
      throw new AppError(
        'VALIDATION_ERROR',
        'No scheduling account is connected for this organization yet.',
      );
    }

    const memberHostIds = await this.roster.linkedHostIds(organizationId, conn.provider);
    const types = await this.providers.get(conn.provider).listEventTypes(conn, { memberHostIds });

    return types
      .filter((et) => et.active)
      .map((et) => ({
        uri: et.id,
        name: et.name,
        active: et.active,
        durationMinutes: et.durationMinutes,
        schedulingUrl: et.schedulingUrl ?? '',
        poolingType: et.poolingType,
        ownerName: et.ownerName,
        ownerType: et.ownerType,
      }))
      // Team pages first: a round robin is the link the office hands out, and
      // burying it under twenty personal pages is how it gets missed.
      .sort((a, b) => {
        const rank = (x: CalendarEventTypeDTO) => (x.poolingType ? 0 : 1);
        return rank(a) - rank(b) || a.name.localeCompare(b.name);
      });
  }
}
