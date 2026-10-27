import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { DEFAULT_VOICEMAIL_MESSAGE, voicemailSettings, type VoicemailSettings } from './voicemail';

export interface VoicemailStatus extends VoicemailSettings {
  defaultMessage: string;
}

/** The organization's voicemail setting. Unset, an AI call leaves the default message. */
@Injectable()
export class VoicemailService {
  constructor(private readonly prisma: PrismaService) {}

  async settings(orgId: string): Promise<VoicemailSettings> {
    const row = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: { voicemail: true } });
    return voicemailSettings(row?.voicemail);
  }

  async status(orgId: string): Promise<VoicemailStatus> {
    return { ...(await this.settings(orgId)), defaultMessage: DEFAULT_VOICEMAIL_MESSAGE };
  }

  /** An empty message goes back to the default one. */
  async update(orgId: string, input: { enabled?: boolean; message?: string | null }): Promise<VoicemailStatus> {
    const current = await this.settings(orgId);
    const message = input.message === undefined ? current.message : input.message?.trim() || DEFAULT_VOICEMAIL_MESSAGE;
    const next = { enabled: input.enabled ?? current.enabled, message: message === DEFAULT_VOICEMAIL_MESSAGE ? null : message };
    const voicemail = next as unknown as Prisma.InputJsonObject;
    await this.prisma.organizationSetting.upsert({ where: { orgId }, create: { orgId, voicemail }, update: { voicemail } });
    return this.status(orgId);
  }
}
