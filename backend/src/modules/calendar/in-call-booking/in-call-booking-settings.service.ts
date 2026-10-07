import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash, randomBytes } from 'node:crypto';
import { AppError } from '../../../common/errors';
import { TENANT_PRISMA, type GuardedPrisma } from '../../../prisma/prisma.service';
import { CredStoreService } from '../../../telnyx/cred-store.service';
import { telnyx } from '../../../telnyx/lead-insights.service';
import { CalendarConnectionsService } from '../calendar-connections.service';
import { CalendarEventTypesService } from '../calendar-event-types.service';
import { CalendarRosterService } from '../calendar-roster.service';
import type { CalendarConnectionMetadata } from '../types';
import { withBookingSection, withoutBookingSection } from './booking-prompt';

/* eslint-disable @typescript-eslint/no-explicit-any */

/** integrations.provider for this feature's row; one per organization. */
export const IN_CALL_BOOKING_PROVIDER = 'in_call_booking';

/** Calendly scopes in-call booking needs on top of the sync's read scopes. */
export const BOOKING_SCOPES = ['availability:read', 'scheduled_events:write'];

/**
 * What is stored in that row's metadata. Its own row rather than the Calendly
 * connection's metadata because reconnecting Calendly (which an owner must do
 * once, to grant the booking scopes) creates a NEW connection row.
 */
export interface InCallBookingConfig {
  eventTypeUri: string;
  eventTypeName: string;
  durationMinutes: number;
  /** sha256 of the bearer token Telnyx sends; the token itself lives only in Telnyx. */
  tokenHash: string;
  /** Telnyx integration secret id and identifier holding the token. */
  secretId: string;
  secretIdentifier: string;
  /** Telnyx shared tool ids, attached to `assistantId`. */
  toolIds: string[];
  assistantId: string;
}

export interface InCallBookingStatusDTO {
  enabled: boolean;
  eventType: { uri: string; name: string; durationMinutes: number } | null;
  calendly: { connected: boolean; scopesOk: boolean };
  telnyx: { connected: boolean; hasAssistant: boolean };
  /** Round-robin event types the owner may choose. Empty when Calendly cannot be read. */
  eventTypes: { uri: string; name: string; durationMinutes: number }[];
  /** Calendly members not linked to an agent — bookings with them cannot be assigned. */
  unlinkedMembers: string[];
  /** Why the lists above could not be read, if they could not. */
  problem: string | null;
}

export const sha256 = (v: string) => createHash('sha256').update(v).digest('hex');

/**
 * The owner's switch for in-call booking, and the Telnyx side of it.
 *
 * Enabling creates, in the office's own Telnyx account: a bearer secret (an
 * integration secret, so the token never appears in a tool definition), and
 * two shared webhook tools pointing at this API, attached to the office's
 * assistant — and appends a marked booking section to the assistant's prompt
 * (booking-prompt.ts) so the AI knows when and how to use them. Disabling
 * removes all of it, leaving the office's own prompt text untouched. Our copy
 * of the token is only its hash.
 */
@Injectable()
export class InCallBookingSettingsService {
  private readonly logger = new Logger(InCallBookingSettingsService.name);

  constructor(
    @Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma,
    private readonly config: ConfigService,
    private readonly creds: CredStoreService,
    private readonly connections: CalendarConnectionsService,
    private readonly eventTypes: CalendarEventTypesService,
    private readonly roster: CalendarRosterService,
  ) {}

  /** The active config, or null when in-call booking is off. */
  async activeConfig(organizationId: string): Promise<InCallBookingConfig | null> {
    const row = await this.row(organizationId);
    return row?.status === 'active' ? (row.metadata as unknown as InCallBookingConfig) : null;
  }

  async status(organizationId: string): Promise<InCallBookingStatusDTO> {
    const conn = await this.connections.syncableOrgRow(organizationId);
    const isCalendly = conn?.provider === 'calendly';
    const scope = ((conn?.metadata ?? {}) as CalendarConnectionMetadata).scope ?? '';
    const scopesOk = isCalendly && BOOKING_SCOPES.every((s) => scope.split(/\s+/).includes(s));
    const t = await this.creds.getCreds(organizationId).catch(() => null);
    const cfg = await this.activeConfig(organizationId);

    let eventTypes: InCallBookingStatusDTO['eventTypes'] = [];
    let unlinkedMembers: string[] = [];
    let problem: string | null = null;
    if (isCalendly) {
      try {
        eventTypes = (await this.eventTypes.list(organizationId))
          // Calendly reports a rotating pool as 'round_robin', or as 'multi_pool' when
          // it is built with the newer host-pool editor or has a fixed co-host too.
          // Both let Calendly choose who hosts; collective (everyone) does not.
          .filter((et) => et.poolingType === 'round_robin' || et.poolingType === 'multi_pool')
          .map((et) => ({ uri: et.uri, name: et.name, durationMinutes: et.durationMinutes }));
        unlinkedMembers = (await this.roster.listMembers(organizationId)).filter((m) => !m.agentId).map((m) => m.name);
      } catch (e) {
        problem = (e as Error).message;
      }
    }

    return {
      enabled: !!cfg,
      eventType: cfg ? { uri: cfg.eventTypeUri, name: cfg.eventTypeName, durationMinutes: cfg.durationMinutes } : null,
      calendly: { connected: isCalendly, scopesOk },
      telnyx: { connected: !!t?.apiKey, hasAssistant: !!t?.assistantId },
      eventTypes,
      unlinkedMembers,
      problem,
    };
  }

  /** Turn on (or switch event type). Re-provisions the Telnyx side from scratch each time. */
  async enable(organizationId: string, eventTypeUri: string): Promise<InCallBookingStatusDTO> {
    const st = await this.status(organizationId);
    if (!st.calendly.connected) throw new AppError('CONFLICT', 'Connect Calendly on Integrations first.');
    if (!st.calendly.scopesOk) {
      throw new AppError(
        'CONFLICT',
        'Calendly has not granted booking permission yet. Add availability:read and scheduled_events:write to your ' +
          'Calendly OAuth app, set CALENDLY_BOOKING_SCOPES=1 in the backend .env, restart, then reconnect Calendly.',
      );
    }
    if (!st.telnyx.connected || !st.telnyx.hasAssistant) {
      throw new AppError('CONFLICT', 'Connect Telnyx and create the AI assistant first.');
    }
    const et = st.eventTypes.find((e) => e.uri === eventTypeUri);
    if (!et) throw new AppError('VALIDATION_ERROR', 'Choose one of your Calendly round-robin (or multi-pool) event types.');

    await this.teardown(organizationId);

    const c = (await this.creds.getCreds(organizationId))!;
    const token = randomBytes(32).toString('base64url');
    const identifier = `ep_booking_${organizationId.replace(/-/g, '')}`;
    const secret = await telnyx(c.apiKey, '/integration_secrets', {
      method: 'POST',
      body: JSON.stringify({ identifier, type: 'bearer', token }),
    });
    const secretId: string = secret.data?.id;

    const toolIds: string[] = [];
    try {
      for (const def of this.toolDefinitions(identifier)) {
        const tool = await telnyx(c.apiKey, '/ai/tools', { method: 'POST', body: JSON.stringify(def) });
        toolIds.push(tool.id ?? tool.data?.id);
        await telnyx(c.apiKey, `/ai/assistants/${c.assistantId}/tools/${toolIds[toolIds.length - 1]}`, { method: 'PUT' });
      }
      await this.setPrompt(c.apiKey, c.assistantId, (p) => withBookingSection(p, et.name, et.durationMinutes));
    } catch (e) {
      await this.removeFromTelnyx(c.apiKey, c.assistantId, toolIds, secretId);
      throw e;
    }

    const config: InCallBookingConfig = {
      eventTypeUri: et.uri,
      eventTypeName: et.name,
      durationMinutes: et.durationMinutes,
      tokenHash: sha256(token),
      secretId,
      secretIdentifier: identifier,
      toolIds,
      assistantId: c.assistantId,
    };
    await this.save(organizationId, 'active', config);
    this.logger.log(`in-call booking enabled for ${organizationId} on ${et.name}`);
    return this.status(organizationId);
  }

  async disable(organizationId: string): Promise<InCallBookingStatusDTO> {
    await this.teardown(organizationId);
    return this.status(organizationId);
  }

  /** Remove whatever an earlier enable created. Best effort on the Telnyx side. */
  private async teardown(organizationId: string): Promise<void> {
    const row = await this.row(organizationId);
    if (!row) return;
    const cfg = row.metadata as unknown as Partial<InCallBookingConfig>;
    const c = await this.creds.getCreds(organizationId).catch(() => null);
    if (c?.apiKey) {
      await this.removeFromTelnyx(c.apiKey, cfg.assistantId ?? c.assistantId, cfg.toolIds ?? [], cfg.secretId);
    }
    await this.prisma.integrations.update({
      where: { id: row.id },
      data: { status: 'inactive', metadata: {}, updated_at: new Date() },
    });
  }

  /** Rewrite the assistant's prompt through `edit`; untouched when the result is the same. */
  private async setPrompt(apiKey: string, assistantId: string, edit: (instructions: string) => string) {
    // GET /ai/assistants/{id} answers with the assistant itself, not under `data`.
    // Misreading it as empty would replace the office's whole prompt.
    const raw = await telnyx(apiKey, `/ai/assistants/${assistantId}`);
    const assistant = raw?.data ?? raw ?? {};
    if (typeof assistant.instructions !== 'string') {
      throw new Error('Could not read the assistant prompt from Telnyx; it was left unchanged.');
    }
    const current: string = assistant.instructions;
    const next = edit(current);
    if (next === current) return;
    await telnyx(apiKey, `/ai/assistants/${assistantId}`, { method: 'PATCH', body: JSON.stringify({ instructions: next }) });
  }

  private async removeFromTelnyx(apiKey: string, assistantId: string, toolIds: string[], secretId?: string) {
    const quiet = (p: Promise<unknown>) => p.catch((e) => this.logger.warn(`in-call booking teardown: ${(e as Error).message}`));
    if (assistantId) await quiet(this.setPrompt(apiKey, assistantId, withoutBookingSection));
    for (const id of toolIds) {
      if (assistantId) await quiet(telnyx(apiKey, `/ai/assistants/${assistantId}/tools/${id}`, { method: 'DELETE' }));
      await quiet(telnyx(apiKey, `/ai/tools/${id}`, { method: 'DELETE' }));
    }
    if (secretId) await quiet(telnyx(apiKey, `/integration_secrets/${secretId}`, { method: 'DELETE' }));
  }

  private row(organizationId: string) {
    return this.prisma.integrations.findFirst({
      where: { organization_id: organizationId, provider: IN_CALL_BOOKING_PROVIDER },
      orderBy: { created_at: 'asc' },
    });
  }

  private async save(organizationId: string, status: 'active' | 'inactive', config: InCallBookingConfig) {
    const existing = await this.row(organizationId);
    const data = { status, integration_type: 'calendar', metadata: config as object, updated_at: new Date() };
    if (existing) {
      await this.prisma.integrations.update({ where: { id: existing.id }, data });
    } else {
      await this.prisma.integrations.create({
        data: { organization_id: organizationId, provider: IN_CALL_BOOKING_PROVIDER, ...data },
      });
    }
  }

  /**
   * The two tools as Telnyx shared webhook tools. lead_id and call_control_id
   * are PRESET — filled by Telnyx from the call, invisible to the model and
   * impossible for it to change — which is what ties a request to one live call.
   */
  toolDefinitions(secretIdentifier: string) {
    const base = (this.config.get<string>('PUBLIC_API_URL') ?? '').replace(/\/+$/, '');
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
          url: `${base}/api/tools/telnyx/booking/availability`,
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
            'call this again with `email`. On success, tell the caller the time and the agent\'s name, and that a calendar ' +
            'invite is on its way by email. If the time was just taken, offer the alternative slots returned.',
          url: `${base}/api/tools/telnyx/booking/book`,
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
