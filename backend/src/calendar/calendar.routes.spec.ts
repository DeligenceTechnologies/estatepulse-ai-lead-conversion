import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { describe, expect, it } from 'vitest';
import { CalendarAvailabilityController } from './availability/calendar-availability.controller';
import { CalendarConnectionController } from './connection/calendar-connection.controller';
import { MeetingTypesController } from './meeting-types/meeting-types.controller';
import { CalendarMembersController } from './members/calendar-members.controller';
import { CalendarWebhookController } from './sync/calendar-webhook.controller';

const CONTROLLERS = [
  CalendarConnectionController,
  CalendarMembersController,
  MeetingTypesController,
  CalendarAvailabilityController,
  CalendarWebhookController,
];

function routes(): string[] {
  return CONTROLLERS.flatMap((controller) => {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller));
    return Object.getOwnPropertyNames(controller.prototype)
      .map((name) => (controller.prototype as unknown as Record<string, unknown>)[name])
      .filter((handler): handler is object => typeof handler === 'function' && Reflect.hasMetadata(METHOD_METADATA, handler))
      .map((handler) => {
        const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
        const path = String(Reflect.getMetadata(PATH_METADATA, handler));
        return `${method} /${[base, path].filter((part) => part && part !== '/').join('/')}`;
      });
  });
}

describe('calendar routes', () => {
  // The frontend (utils/calendarApi.ts) calls exactly these. Splitting the
  // module into folders must never move one.
  it('keeps the public API unchanged', () => {
    expect(routes().sort()).toEqual(
      [
        'GET /org-settings/calendar',
        'DELETE /org-settings/calendar',
        'POST /org-settings/calendar/activate',
        'POST /org-settings/calendar/calendly/authorize',
        'GET /org-settings/calendar/calendly/callback',
        'POST /org-settings/calendar/cal/teams',
        'POST /org-settings/calendar/cal/connect',
        'GET /org-settings/calendar/members',
        'POST /org-settings/calendar/members/add-agent',
        'GET /org-settings/calendar/event-types',
        'GET /org-settings/calendar/availability',
        'POST /org-settings/calendar/availability/sync',
        'POST /calendar-webhooks/:connectionId',
      ].sort(),
    );
  });

  it('registers each route once', () => {
    const all = routes();
    expect(new Set(all).size).toBe(all.length);
  });
});
