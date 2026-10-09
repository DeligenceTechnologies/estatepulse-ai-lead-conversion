import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { toWorkingHoursJson } from '@/common/utils/working-hours';
import { UpdateOrgSettingDto } from './dto/update-org-setting.dto';

const PUBLIC_FIELDS = { id: true, timezone: true, workingHours: true, updatedAt: true } as const;

@Injectable()
export class OrgSettingService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * The organization's settings. Organizations created before settings
   * existed get their row (with the defaults) on first read.
   */
  async find(orgId: string) {
    const existing = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: PUBLIC_FIELDS });
    if (existing) return existing;
    try {
      return await this.prisma.organizationSetting.create({ data: { orgId }, select: PUBLIC_FIELDS });
    } catch (error) {
      // Two first reads at once: the other one created it.
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        return this.prisma.organizationSetting.findUniqueOrThrow({ where: { orgId }, select: PUBLIC_FIELDS });
      }
      rethrowPrismaError(error, 'Organization settings');
    }
  }

  async update(orgId: string, { workingHours, ...dto }: UpdateOrgSettingDto) {
    const data = { ...dto, ...(workingHours ? { workingHours: toWorkingHoursJson(workingHours) } : {}) };
    try {
      return await this.prisma.organizationSetting.upsert({
        where: { orgId },
        create: { orgId, ...data },
        update: data,
        select: PUBLIC_FIELDS,
      });
    } catch (error) {
      rethrowPrismaError(error, 'Organization settings');
    }
  }
}
