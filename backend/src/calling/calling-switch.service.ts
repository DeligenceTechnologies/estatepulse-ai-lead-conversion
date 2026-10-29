import { Injectable } from '@nestjs/common';
import { EnrollmentStatus, IntegrationProvider, IntegrationStatus } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { InCallBookingSettingsService } from '@/calendar/booking/in-call-booking-settings.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { stepsOf } from '@/followup/followup.service';
import { RetellCredentialsService } from '@/retell/retell-credentials.service';
import { RetellSmsService } from '@/retell/retell-sms.service';
import { CallSlots } from '@/telnyx/calls/call-slots';
import { StrategyStoreService } from '@/telnyx/strategy-store.service';
import { CallingProviders, SMS_UNAVAILABLE, type CallingProviderName } from './calling-providers';

const LABEL: Record<CallingProviderName, string> = { telnyx: 'Telnyx', retell: 'Retell' };

export interface SwitchPreview {
  from: CallingProviderName;
  to: CallingProviderName;
  liveCalls: number;
  /** Any of these refuses the switch. */
  blockers: string[];
  /** What the owner should know before confirming. */
  warnings: string[];
}

/**
 * Moving an organization between Telnyx and Retell. Refused while a call is
 * live or the target is not set up. Calls already queued stay queued: the
 * call worker picks the provider when it dials, so they go out through the
 * new one, still inside the contact window. Past calls keep their provider.
 */
@Injectable()
export class CallingSwitchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly providers: CallingProviders,
    private readonly retellCreds: RetellCredentialsService,
    private readonly slots: CallSlots,
    private readonly strategies: StrategyStoreService,
    private readonly booking: InCallBookingSettingsService,
    private readonly audit: AuditService,
    private readonly retellSms: RetellSmsService,
  ) {}

  /** The provider in use and whether it can text for this organization right now. */
  async current(orgId: string) {
    const provider = await this.providers.for(orgId);
    return { provider: provider.name, capabilities: provider.capabilities, sms: await provider.smsCapability(orgId) };
  }

  async preview(orgId: string, to: CallingProviderName): Promise<SwitchPreview> {
    const [from, liveCalls] = await Promise.all([this.providers.nameFor(orgId), this.slots.inUse(orgId).catch(() => 0)]);
    const blockers: string[] = [];
    if (from === to) blockers.push(`This organization already calls through ${LABEL[to]}.`);
    if (liveCalls > 0) blockers.push(`${liveCalls} call(s) are live right now. Switch once they have ended.`);
    if (to === 'retell') blockers.push(...(await this.retellNotReady(orgId)));

    const warnings = ['Calls already queued will dial through the new provider, still inside the contact window.'];
    if (to === 'telnyx') warnings.push(...(await this.telnyxNotes(orgId)));
    if (to === 'retell') {
      // Texts go through Retell only once its SMS agent is set up on an eligible number; what the owner has to know is said here.
      const c = await this.retellCreds.getCreds(orgId);
      const sms = await this.retellSms.capability(orgId, c ? { ...c, active: true } : c);
      if (!sms.available) {
        warnings.push(`SMS will not be sent while you call through Retell: ${sms.reason ?? SMS_UNAVAILABLE}`);
        const smsSteps = (await this.strategies.getStrategy(orgId)).steps.filter((s) => s.channel === 'sms').length;
        if (smsSteps) warnings.push(`Your outreach strategy has ${smsSteps} SMS step(s); they will not be sent while you call through Retell.`);
        const enrolled = await this.enrolledInSmsSequences(orgId);
        if (enrolled) warnings.push(`${enrolled} lead(s) are in follow-up sequences with SMS steps; those steps will not be sent.`);
      } else if (sms.reason) {
        warnings.push(`SMS goes through Retell’s SMS agent. ${sms.reason}`);
      }
    }
    if (await this.booking.activeConfig(orgId)) warnings.push(`In-call booking will be switched off; turn it on again once you are on ${LABEL[to]}.`);
    return { from, to, liveCalls, blockers, warnings };
  }

  async switch(orgId: string, to: CallingProviderName, actorId: string): Promise<SwitchPreview> {
    const preview = await this.preview(orgId, to);
    if (preview.blockers.length) {
      throw new AppError('CONFLICT', preview.blockers.join(' '), preview.blockers.map((message) => ({ path: 'provider', message })));
    }
    // Torn down on the provider being left, while its credentials are still the active ones.
    if (await this.booking.activeConfig(orgId)) await this.booking.disable(orgId);
    // Retell is set up before the switch, so it always has an account here. Telnyx may not: its accounts can
    // only be connected while it is the provider, so switching to it first and connecting after must work.
    const target = to === 'retell' ? (await this.retellCreds.getCreds(orgId))?.id : (await this.latestTelnyx(orgId))?.id;
    await this.prisma.$transaction(async (tx) => {
      await tx.integration.updateMany({
        where: { orgId, provider: { in: [IntegrationProvider.telnyx, IntegrationProvider.retell] }, status: IntegrationStatus.active },
        data: { status: IntegrationStatus.inactive },
      });
      if (target) await tx.integration.update({ where: { id: target }, data: { status: IntegrationStatus.active } });
      await this.audit.record(
        { orgId, actorType: 'user', actorId, action: 'calling_provider.switched', entityType: 'integration', entityId: target ?? null, payload: { from: preview.from, to } },
        tx,
      );
    });
    return { ...preview, from: to };
  }

  /** Retell can be set up completely while Telnyx is still in use, so it must be before the switch. */
  private async retellNotReady(orgId: string): Promise<string[]> {
    const c = await this.retellCreds.getCreds(orgId);
    if (!c?.apiKey) return ['Connect a Retell account first.'];
    return [
      ...(c.webhookKey ? [] : ['Add the Retell webhook key.']),
      ...(c.agentId ? [] : ['Create the Retell agent first.']),
      ...(c.fromNumber ? [] : ['Choose the Retell number calls come from.']),
    ];
  }

  /**
   * A Telnyx account can only be connected or edited while Telnyx is the
   * provider, so nothing about it blocks the switch; what is missing is said,
   * to be done right after.
   */
  private async telnyxNotes(orgId: string): Promise<string[]> {
    const row = await this.latestTelnyx(orgId);
    if (!row?.credentials) return ['No Telnyx account is connected yet: no calls go out until you connect one after switching.'];
    return row.phoneNumber ? ['Your saved Telnyx account is used again.'] : ['Your saved Telnyx account has no number to call from yet: choose one after switching.'];
  }

  /** The Telnyx account a reconnect would bring back: the one used most recently. */
  private latestTelnyx(orgId: string) {
    return this.prisma.integration.findFirst({
      where: { orgId, provider: IntegrationProvider.telnyx, revokedAt: null },
      orderBy: { updatedAt: 'desc' },
      select: { id: true, credentials: true, phoneNumber: true },
    });
  }

  private async enrolledInSmsSequences(orgId: string): Promise<number> {
    const rows = await this.prisma.sequenceEnrollment.findMany({
      where: { orgId, status: EnrollmentStatus.active },
      select: { sequence: { select: { steps: true } } },
    });
    return rows.filter((r) => stepsOf(r.sequence).some((s) => s.actionType === 'sms')).length;
  }
}
