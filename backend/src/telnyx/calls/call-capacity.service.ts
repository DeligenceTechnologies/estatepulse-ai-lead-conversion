import { Injectable, Logger } from '@nestjs/common';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { TelnyxCredentialsService, type TelnyxCreds } from '../telnyx-credentials.service';
import { telnyx } from '../telnyx-api';
import { CallSlots } from './call-slots';
import { DEFAULT_CALL_LIMIT } from './call.types';

interface VoiceProfile {
  concurrent_call_limit?: number | null;
  name?: string;
}

export interface CallCapacityStatus {
  appLimit: number;
  telnyxLimit: number | null;
  inUse: number;
  inSync: boolean;
  connected: boolean;
  profileName: string | null;
  telnyxError: string | null;
}

function invalid(message: string): AppError {
  return new AppError('VALIDATION_ERROR', message, [{ path: 'maxConcurrentCalls', message }]);
}

export function telnyxReason(message: string): string | null {
  const body = message.slice(Math.max(0, message.indexOf('{')));
  try {
    const errors = (JSON.parse(body) as { errors?: { detail?: string; title?: string }[] }).errors ?? [];
    const words = errors.map((e) => e.detail || e.title).filter(Boolean);
    if (words.length) return words.join(' ');
  } catch {
    for (const field of ['detail', 'title']) {
      const match = body.match(new RegExp(`"${field}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (match) return JSON.parse(`"${match[1]}"`) as string;
    }
  }
  return null;
}

@Injectable()
export class CallCapacityService {
  private readonly logger = new Logger(CallCapacityService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly creds: TelnyxCredentialsService,
    private readonly slots: CallSlots,
  ) {}

  async status(orgId: string): Promise<CallCapacityStatus> {
    const [appLimit, inUse, c] = await Promise.all([this.appLimit(orgId), this.inUse(orgId), this.creds.getCreds(orgId)]);
    const empty = { appLimit, inUse, connected: Boolean(c?.apiKey), telnyxLimit: null, inSync: false, profileName: null, telnyxError: null };
    if (!c?.apiKey) return empty;
    try {
      const profile = await telnyx<{ data?: VoiceProfile }>(c.apiKey, `/outbound_voice_profiles/${await this.profileId(orgId, c)}`);
      return this.describe(appLimit, inUse, profile.data);
    } catch (error) {
      return { ...empty, telnyxError: (error as Error).message };
    }
  }

  async setLimit(orgId: string, limit: number): Promise<CallCapacityStatus> {
    const c = await this.creds.getCreds(orgId);
    if (!c?.apiKey) throw invalid('Connect a Telnyx account before setting the call limit.');
    const profileId = await this.profileId(orgId, c);
    let profile: VoiceProfile | undefined;
    try {
      profile = await this.patchLimit(c, profileId, limit);
    } catch (error) {
      throw invalid(
        telnyxReason((error as Error).message) ??
          `Telnyx did not accept ${limit} concurrent calls. If this is above your Telnyx account limit, ask Telnyx support to raise it first.`,
      );
    }
    const [, inUse] = await Promise.all([
      this.prisma.organizationSetting.upsert({
        where: { orgId },
        create: { orgId, maxConcurrentCalls: limit },
        update: { maxConcurrentCalls: limit },
      }),
      this.inUse(orgId),
    ]);
    return this.describe(limit, inUse, { ...profile, concurrent_call_limit: profile?.concurrent_call_limit ?? limit });
  }

  async pushToTelnyx(orgId: string): Promise<void> {
    try {
      const c = await this.creds.getCreds(orgId);
      if (c?.apiKey) await this.patchLimit(c, await this.profileId(orgId, c), await this.appLimit(orgId));
    } catch (error) {
      this.logger.warn(`Could not sync the call limit to Telnyx for org ${orgId}: ${(error as Error).message}`);
    }
  }

  private describe(appLimit: number, inUse: number, profile?: VoiceProfile): CallCapacityStatus {
    const telnyxLimit = profile?.concurrent_call_limit ?? null;
    return { appLimit, inUse, connected: true, telnyxLimit, inSync: telnyxLimit === appLimit, profileName: profile?.name ?? null, telnyxError: null };
  }

  private async patchLimit(c: TelnyxCreds, profileId: string, limit: number): Promise<VoiceProfile | undefined> {
    const res = await telnyx<{ data?: VoiceProfile }>(c.apiKey, `/outbound_voice_profiles/${profileId}`, {
      method: 'PATCH',
      body: JSON.stringify({ concurrent_call_limit: limit }),
    });
    return res.data;
  }

  private inUse(orgId: string): Promise<number> {
    return this.slots.inUse(orgId).catch(() => 0);
  }

  private async appLimit(orgId: string): Promise<number> {
    const s = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { maxConcurrentCalls: true } });
    return s?.maxConcurrentCalls ?? DEFAULT_CALL_LIMIT;
  }

  private async profileId(orgId: string, c: TelnyxCreds): Promise<string> {
    const connectionId = await this.creds.ensureConnectionId(orgId, c);
    if (!connectionId) throw invalid('No Call Control application found on the Telnyx account.');
    const res = await telnyx<{ data?: { outbound?: { outbound_voice_profile_id?: string | null } } }>(
      c.apiKey,
      `/call_control_applications/${connectionId}`,
    );
    const id = res.data?.outbound?.outbound_voice_profile_id;
    if (!id) throw invalid('Your Telnyx Call Control application has no Outbound Voice Profile. Assign one in the Telnyx portal, then try again.');
    return String(id);
  }
}
