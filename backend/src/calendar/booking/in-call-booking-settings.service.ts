import { randomBytes } from 'node:crypto';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { IntegrationEnv } from '@/common/utils/interface';
import { telnyx } from '@/telnyx/telnyx-api';
import { TelnyxCredentialsService } from '@/telnyx/telnyx-credentials.service';
import { CalendarAccessService } from '../connection/calendar-access.service';
import { inUse } from '../connection/connection-state';
import { findLinkedUsers } from '../members/linked-users';
import { SchedulingProvider } from '../providers/scheduling-provider';
import { withBookingSection, withoutBookingSection } from './booking-prompt';

/** Calendly scopes in-call booking needs on top of the sync's read scopes. */
export const BOOKING_SCOPES = ['availability:read', 'scheduled_events:write'];

export interface InCallBookingConfig {
  eventTypeUri: string;
  eventTypeName: string;
  durationMinutes: number;
  /** sha256 of the bearer token Telnyx sends; the token itself lives only in Telnyx. */
  tokenHash: string;
  secretId: string;
  secretIdentifier: string;
  toolIds: string[];
  assistantId: string;
}

export interface InCallBookingStatusDTO {
  enabled: boolean;
  eventType: { uri: string; name: string; durationMinutes: number } | null;
  calendly: { connected: boolean; scopesOk: boolean };
  telnyx: { connected: boolean; hasAssistant: boolean };
  eventTypes: { uri: string; name: string; durationMinutes: number }[];
  unlinkedMembers: string[];
  problem: string | null;
}

/** A token granted without a scope list (Calendly's legacy "default") carries every scope the app has. */
export function grantsBooking(scope: string | null): boolean {
  if (!scope || scope.trim() === 'default') return true;
  const granted = scope.split(/\s+/);
  return BOOKING_SCOPES.every((s) => granted.includes(s));
}

/**
 * The switch for in-call booking, and the Telnyx side of it. Enabling creates
 * in the organization's Telnyx account a bearer integration secret and two
 * webhook tools pointing at this API, attaches them to its assistant and adds
 * a marked booking section to the assistant's prompt. Disabling removes all of
 * it and leaves the organization's own prompt text untouched. Only the token's
 * hash is kept here.
 */
@Injectable()
export class InCallBookingSettingsService {
  private readonly logger = new Logger(InCallBookingSettingsService.name);
  private readonly publicApiUrl: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly access: CalendarAccessService,
    private readonly provider: SchedulingProvider,
    config: ConfigService<IntegrationEnv, true>,
  ) {
    this.publicApiUrl = (config.get('PUBLIC_API_URL', { infer: true }) ?? '').replace(/\/+$/, '');
  }

  async activeConfig(orgId: string): Promise<InCallBookingConfig | null> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true } });
    const config = row?.inCallBooking as InCallBookingConfig | null | undefined;
    return config?.tokenHash ? config : null;
  }

  async status(orgId: string): Promise<InCallBookingStatusDTO> {
    const [connection, telnyxCreds, config] = await Promise.all([
      this.prisma.calendarConnection.findFirst({ where: inUse(orgId), select: { id: true, provider: true, scope: true } }),
      this.creds.getCreds(orgId).catch(() => null),
      this.activeConfig(orgId),
    ]);
    const isCalendly = connection?.provider === 'calendly';

    let eventTypes: InCallBookingStatusDTO['eventTypes'] = [];
    let unlinkedMembers: string[] = [];
    let problem: string | null = null;
    if (isCalendly) {
      try {
        eventTypes = (await this.access.useActive(orgId, (active, secret) => this.provider.eventTypes(active, secret)))
          .filter((et) => et.poolingType === 'round_robin' || et.poolingType === 'multi_pool')
          .map((et) => ({ uri: et.id, name: et.name, durationMinutes: et.durationMinutes }));
        const members = await this.prisma.calendarMember.findMany({
          where: { connectionId: connection.id },
          select: { name: true, email: true },
        });
        const linked = await findLinkedUsers(this.prisma, orgId, members);
        unlinkedMembers = members.filter((m) => !linked.has(m.email.toLowerCase())).map((m) => m.name);
      } catch (error) {
        problem = (error as Error).message;
      }
    }

    return {
      enabled: !!config,
      eventType: config ? { uri: config.eventTypeUri, name: config.eventTypeName, durationMinutes: config.durationMinutes } : null,
      calendly: { connected: isCalendly, scopesOk: isCalendly && grantsBooking(connection.scope) },
      telnyx: { connected: !!telnyxCreds?.apiKey, hasAssistant: !!telnyxCreds?.assistantId },
      eventTypes,
      unlinkedMembers,
      problem,
    };
  }

  /** Turns it on, or switches the event type; the Telnyx side is provisioned afresh each time. */
  async enable(orgId: string, eventTypeUri: string): Promise<InCallBookingStatusDTO> {
    if (!this.publicApiUrl) throw new AppError('CONFLICT', 'PUBLIC_API_URL is not configured on the server.');
    const st = await this.status(orgId);
    if (!st.calendly.connected) throw new AppError('CONFLICT', 'Connect Calendly first.');
    if (!st.calendly.scopesOk) {
      throw new AppError(
        'CONFLICT',
        `Calendly has not granted booking permission. Add ${BOOKING_SCOPES.join(' and ')} to the Calendly OAuth app, then reconnect Calendly.`,
      );
    }
    if (!st.telnyx.connected || !st.telnyx.hasAssistant) throw new AppError('CONFLICT', 'Connect Telnyx and create the AI assistant first.');
    const et = st.eventTypes.find((e) => e.uri === eventTypeUri);
    if (!et) throw new AppError('VALIDATION_ERROR', 'Choose one of your Calendly round-robin event types.');

    await this.teardown(orgId);

    const c = (await this.creds.getCreds(orgId))!;
    const token = randomBytes(32).toString('base64url');
    const identifier = `ep_booking_${orgId.replace(/-/g, '')}`;
    const secret = await telnyx<{ data?: { id: string } }>(c.apiKey, '/integration_secrets', {
      method: 'POST',
      body: JSON.stringify({ identifier, type: 'bearer', token }),
    });
    const secretId = secret.data?.id ?? '';

    const toolIds: string[] = [];
    try {
      for (const def of this.toolDefinitions(identifier)) {
        const tool = await telnyx<{ id?: string; data?: { id: string } }>(c.apiKey, '/ai/tools', { method: 'POST', body: JSON.stringify(def) });
        const toolId = tool.id ?? tool.data?.id ?? '';
        toolIds.push(toolId);
        await telnyx(c.apiKey, `/ai/assistants/${c.assistantId}/tools/${toolId}`, { method: 'PUT' });
      }
      await this.setPrompt(c.apiKey, c.assistantId, (p) => withBookingSection(p, et.name, et.durationMinutes));
    } catch (error) {
      await this.removeFromTelnyx(c.apiKey, c.assistantId, toolIds, secretId);
      throw error;
    }

    const config: InCallBookingConfig = {
      eventTypeUri: et.uri,
      eventTypeName: et.name,
      durationMinutes: et.durationMinutes,
      tokenHash: sha256Hex(token),
      secretId,
      secretIdentifier: identifier,
      toolIds,
      assistantId: c.assistantId,
    };
    await this.save(orgId, config as unknown as Prisma.InputJsonObject);
    this.logger.log(`in-call booking enabled for ${orgId} on ${et.name}`);
    return this.status(orgId);
  }

  async disable(orgId: string): Promise<InCallBookingStatusDTO> {
    await this.teardown(orgId);
    return this.status(orgId);
  }

  private async teardown(orgId: string): Promise<void> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { inCallBooking: true } });
    const config = row?.inCallBooking as Partial<InCallBookingConfig> | null | undefined;
    if (!config) return;
    const c = await this.creds.getCreds(orgId).catch(() => null);
    if (c?.apiKey) await this.removeFromTelnyx(c.apiKey, config.assistantId ?? c.assistantId, config.toolIds ?? [], config.secretId);
    await this.save(orgId, Prisma.DbNull);
  }

  /** Rewrites the assistant's prompt through `edit`; refuses to write when the current prompt cannot be read. */
  private async setPrompt(apiKey: string, assistantId: string, edit: (instructions: string) => string): Promise<void> {
    const raw = await telnyx<{ data?: { instructions?: unknown }; instructions?: unknown }>(apiKey, `/ai/assistants/${assistantId}`);
    const current = (raw?.data ?? raw)?.instructions;
    if (typeof current !== 'string') throw new AppError('UPSTREAM_ERROR', 'Could not read the assistant prompt from Telnyx; it was left unchanged.');
    const next = edit(current);
    if (next === current) return;
    await telnyx(apiKey, `/ai/assistants/${assistantId}`, { method: 'PATCH', body: JSON.stringify({ instructions: next }) });
  }

  private async removeFromTelnyx(apiKey: string, assistantId: string | undefined, toolIds: string[], secretId?: string): Promise<void> {
    const quiet = (p: Promise<unknown>) => p.catch((error) => this.logger.warn(`in-call booking teardown: ${(error as Error).message}`));
    if (assistantId) await quiet(this.setPrompt(apiKey, assistantId, withoutBookingSection));
    for (const id of toolIds.filter(Boolean)) {
      if (assistantId) await quiet(telnyx(apiKey, `/ai/assistants/${assistantId}/tools/${id}`, { method: 'DELETE' }));
      await quiet(telnyx(apiKey, `/ai/tools/${id}`, { method: 'DELETE' }));
    }
    if (secretId) await quiet(telnyx(apiKey, `/integration_secrets/${secretId}`, { method: 'DELETE' }));
  }

  private async save(orgId: string, inCallBooking: Prisma.InputJsonObject | typeof Prisma.DbNull): Promise<void> {
    await this.prisma.organizationSetting.upsert({
      where: { orgId },
      create: { orgId, inCallBooking },
      update: { inCallBooking },
    });
  }

  /**
   * The two tools as Telnyx webhook tools. lead_id and call_control_id are
   * preset: filled by Telnyx from the call, out of the model's reach, which is
   * what ties a request to one live call.
   */
  toolDefinitions(secretIdentifier: string) {
    const shared = {
      method: 'POST',
      headers: [{ name: 'Authorization', value: `Bearer {{#integration_secret}}${secretIdentifier}{{/integration_secret}}` }],
      preset_body_fields: { lead_id: '{{leadId}}', call_control_id: '{{call_control_id}}' },
    };
    return [
      {
        type: 'webhook',
        display_name: 'EstatePulse: check appointment availability',
        timeout_ms: 15000,
        webhook: {
          ...shared,
          name: 'check_availability',
          description:
            'Find open times for a meeting with one of our agents. Use it as soon as the caller wants to book a meeting, ' +
            'consultation or showing. Pass `day` as the day they asked about (YYYY-MM-DD, "today", "tomorrow" or a weekday ' +
            'name) and `preferred_time` (24-hour HH:MM) if they named a time. Offer two or three of the returned slots by ' +
            'reading their `spoken` text exactly. Never offer a time this tool did not return.',
          url: `${this.publicApiUrl}/tools/telnyx/booking/availability`,
          body_parameters: {
            type: 'object',
            properties: {
              day: { type: 'string', description: 'YYYY-MM-DD, "today", "tomorrow" or a weekday name. Omit for the next available days.' },
              preferred_time: { type: 'string', description: 'The time the caller asked for, 24-hour HH:MM, e.g. 15:30.' },
            },
            required: [],
          },
          messages: [
            { type: 'request_start', content: 'One moment, let me check the calendar.' },
            { type: 'request_response_delayed', content: 'Still checking, just a second.', timing_ms: 5000 },
          ],
        },
      },
      {
        type: 'webhook',
        display_name: 'EstatePulse: book appointment',
        timeout_ms: 20000,
        webhook: {
          ...shared,
          name: 'book_appointment',
          description:
            'Book the meeting time the caller chose. `start_time` must be the exact `start` value of a slot returned by ' +
            'check_availability. If the result says email_required, ask for their email, spell it back to confirm, then ' +
            "call this again with `email`. On success, tell the caller the time and the agent's name, and that a calendar " +
            'invite is on its way by email. If the time was just taken, offer the alternative slots returned.',
          url: `${this.publicApiUrl}/tools/telnyx/booking/book`,
          body_parameters: {
            type: 'object',
            properties: {
              start_time: { type: 'string', description: 'The `start` of the chosen slot, exactly as returned.' },
              email: { type: 'string', description: "The caller's email, only if asked for and confirmed." },
              name: { type: 'string', description: "The caller's full name, only if we do not already have it." },
            },
            required: ['start_time'],
          },
          messages: [
            { type: 'request_start', content: 'Great, booking that for you now.' },
            { type: 'request_response_delayed', content: 'Almost done.', timing_ms: 6000 },
          ],
        },
      },
    ];
  }
}
