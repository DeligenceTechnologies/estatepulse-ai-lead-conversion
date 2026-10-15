import { ConflictException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { toWorkingHoursJson } from '@/common/utils/working-hours';
import { AGENT_ROLE_WHERE } from '@/lead/lead-scope';
import { UpdateOrgSettingDto } from './dto/update-org-setting.dto';

const PUBLIC_FIELDS = { id: true, timezone: true, workingHours: true, updatedAt: true } as const;

@Injectable()
export class OrgSettingService {
  constructor(private readonly prisma: PrismaService) {}

  async find(orgId: string) {
    const existing = await this.prisma.organizationSetting.findUnique({ where: { orgId }, select: PUBLIC_FIELDS });
    if (existing) return existing;
    try {
      return await this.prisma.organizationSetting.create({ data: { orgId }, select: PUBLIC_FIELDS });
    } catch (error) {
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

  async setLeadAssignment(orgId: string, userId: string, assignToMe: boolean) {
    const [owner, agentRole] = await Promise.all([
      this.prisma.user.findFirst({
        where: { id: userId, orgId, roles: { some: { role: { isSystem: true } } } },
        select: { id: true },
      }),
      this.prisma.role.findFirst({ where: { orgId, ...AGENT_ROLE_WHERE }, select: { id: true } }),
    ]);
    if (!owner) {
      throw new ForbiddenException('Only an owner can take leads from this setting');
    }
    if (!agentRole) {
      throw new ConflictException('This organization has no "Agent" role. Create it under Roles, then try again.');
    }

    if (assignToMe) {
      await this.prisma.userRole.createMany({ data: [{ userId, roleId: agentRole.id }], skipDuplicates: true });
    } else {
      await this.prisma.userRole.deleteMany({ where: { userId, roleId: agentRole.id } });
    }
    return { assignToMe };
  }
}
