import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { AGENT_ROLE_WHERE } from '@/lead/lead-scope';
import { normalizePhone } from '@/telnyx/phone';
import { CallToolsService } from '@/telnyx/tools/call-tools.service';
import type { UpdateLiveTransferDto } from './dto/live-transfer.dto';
import { DEFAULT_HOLD_MESSAGE, DEFAULT_LIVE_TRANSFER, liveTransferSettings, transferToolWanted, type LiveTransferSettings } from './live-transfer';

export interface LiveTransferStatus extends LiveTransferSettings {
  defaultHoldMessage: string;
  /** Active agents opted in to live transfers, and how many of them have a phone number to ring. */
  agents: { optedIn: number; withPhone: number };
  /** Why transfers would not happen right now, for the settings page; null when nothing stands in the way. */
  problem: string | null;
}

/**
 * The organization's live-transfer switch and its options. Turning it on or changing its triggers
 * puts the transfer tool on the assistant (or takes it off) through the call tools, which carry it.
 */
@Injectable()
export class LiveTransferSettingsService {
  private readonly logger = new Logger(LiveTransferSettingsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly callTools: CallToolsService,
  ) {}

  async read(orgId: string): Promise<LiveTransferSettings> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { liveTransfer: true } });
    return liveTransferSettings(row?.liveTransfer);
  }

  async status(orgId: string, problem: string | null = null): Promise<LiveTransferStatus> {
    const [s, tools, agents] = await Promise.all([
      this.read(orgId),
      this.callTools.settings(orgId),
      this.prisma.user.findMany({
        where: { orgId, status: 'active', acceptsLiveTransfers: true, roles: { some: { role: AGENT_ROLE_WHERE } } },
        select: { phone: true },
      }),
    ]);
    const withPhone = agents.filter((a) => normalizePhone(a.phone).length >= 8).length;
    if (!problem && s.enabled) {
      if (!tools.enabled) problem = 'Turn on "Callbacks and outcomes" in AI Settings: the transfer tool rides with it.';
      else if (!withPhone) problem = 'No agent takes live transfers yet. On Team, turn on "Live call transfers" for an agent with a phone number.';
      else if (!s.onHotLead && !s.onRequest) problem = 'Choose when to transfer: hot leads, leads who ask for a person, or both.';
    }
    return { ...s, defaultHoldMessage: DEFAULT_HOLD_MESSAGE, agents: { optedIn: agents.length, withPhone }, problem };
  }

  async update(orgId: string, patch: UpdateLiveTransferDto): Promise<LiveTransferStatus> {
    const current = await this.read(orgId);
    const next: LiveTransferSettings = {
      enabled: patch.enabled ?? current.enabled,
      ringSeconds: patch.ringSeconds ?? current.ringSeconds,
      agentsPerTransfer: patch.agentsPerTransfer ?? current.agentsPerTransfer,
      onHotLead: patch.onHotLead ?? current.onHotLead,
      onRequest: patch.onRequest ?? current.onRequest,
      holdMessage: patch.holdMessage === undefined ? current.holdMessage : patch.holdMessage || DEFAULT_LIVE_TRANSFER.holdMessage,
    };
    const liveTransfer = next as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, liveTransfer }, update: { liveTransfer } });

    // The tool and its prompt lines change only with the switch or the triggers.
    const toolChanged =
      transferToolWanted(current) !== transferToolWanted(next) ||
      (transferToolWanted(next) && (current.onHotLead !== next.onHotLead || current.onRequest !== next.onRequest));
    let problem: string | null = null;
    if (toolChanged && (await this.callTools.settings(orgId)).enabled) {
      try {
        await this.callTools.refresh(orgId);
      } catch (error) {
        this.logger.warn(`live transfer for org ${orgId}: ${(error as Error).message}`);
        problem = `Saved, but the assistant could not be updated: ${(error as Error).message}`;
      }
    }
    return this.status(orgId, problem);
  }
}
