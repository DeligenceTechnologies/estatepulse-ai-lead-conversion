import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BaseStatus, Prisma } from '@prisma/client';
import { PrismaService } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { generatePassword, hashPassword } from '@/common/utils/password';
import { MailService } from '@/common/service/mail.service';
import type { AppEnv } from '@/common/utils/interface';
import { paginate } from '@/common/pagination/paginate';
import type { ListQuery } from '@/common/pagination/pagination.types';
import type { AuthContext } from '@/auth/auth.types';
import { CreateUserDto } from './dto/create-user.dto';
import { UpdateUserDto } from './dto/update-user.dto';
import { welcomeEmail, type WelcomeEmailInput } from './templates/welcome-email';
import { toWorkingHoursJson } from '@/common/utils/working-hours';

const OMIT_PASSWORD = { password: true } as const;
const WITH_ROLES = {
  roles: {
    select: { role: { select: { id: true, name: true, isSystem: true } } },
    orderBy: { createdAt: 'asc' },
  },
} as const;

/** `roles: [{ role }]` from Prisma becomes `roles: [role]` in every response. */
type RoleSummary = { id: string; name: string; isSystem: boolean };
function flattenRoles<U extends { roles: { role: RoleSummary }[] }>(
  user: U,
): Omit<U, 'roles'> & { roles: RoleSummary[] } {
  return { ...user, roles: user.roles.map(({ role }) => role) };
}

/** Holding the system role makes a user an owner. */
const OWNER_FILTER = { roles: { some: { role: { isSystem: true } } } } satisfies Prisma.UserWhereInput;

export interface CredentialsEmailResult {
  sent: boolean;
  to: string;
  /** Present only when `sent` is false. */
  reason?: string;
}

@Injectable()
export class UserService {
  private readonly logger = new Logger(UserService.name);
  private readonly loginUrl?: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly mail: MailService,
    config: ConfigService<AppEnv, true>,
  ) {
    const appUrl = config.get('APP_URL', { infer: true });
    this.loginUrl = appUrl ? `${appUrl.replace(/\/+$/, '')}/login` : undefined;
  }

  async create(dto: CreateUserDto) {
    const organization = await this.prisma.organization.findUnique({
      where: { id: dto.orgId },
      select: { id: true, name: true },
    });
    if (!organization) {
      throw new NotFoundException('Organization not found');
    }
    const { roleIds, workingHours, ...fields } = dto;
    await this.findRolesInOrg(roleIds, dto.orgId);

    const password = generatePassword();
    let user;
    try {
      user = flattenRoles(
        await this.prisma.user.create({
          data: {
            ...fields,
            ...(workingHours ? { workingHours: toWorkingHoursJson(workingHours) } : {}),
            password: await hashPassword(password),
            roles: { create: roleIds.map((roleId) => ({ roleId })) },
          },
          omit: OMIT_PASSWORD,
          include: WITH_ROLES,
        }),
      );
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }

    const credentialsEmail = await this.sendCredentials({
      firstName: user.firstName,
      organizationName: organization.name,
      roleName: user.roles.map((role) => role.name).join(', '),
      email: user.email,
      password,
    });

    return { ...user, credentialsEmail };
  }

  private async sendCredentials(input: Omit<WelcomeEmailInput, 'loginUrl'>): Promise<CredentialsEmailResult> {
    if (!this.mail.enabled) {
      return { sent: false, to: input.email, reason: 'Email is not configured on the server' };
    }
    try {
      await this.mail.send({ to: input.email, ...welcomeEmail({ ...input, loginUrl: this.loginUrl }) });
      return { sent: true, to: input.email };
    } catch (error) {
      this.logger.error(`Could not send credentials to ${input.email}: ${(error as Error).message}`);
      return { sent: false, to: input.email, reason: 'The email could not be sent' };
    }
  }

  findAll(query: ListQuery, auth: AuthContext) {
    return paginate(query, {
      where: { orgId: auth.organizationId } as Prisma.UserWhereInput,
      searchFields: ['firstName', 'lastName', 'email'],
      filters: {
        status: { type: 'enum', values: Object.values(BaseStatus) },
        // Members holding any of the given roles.
        roleId: { type: 'uuid', multiple: true, field: 'roles.some.roleId' },
      },
      sortableFields: ['createdAt'] as const,
      defaultSort: [{ createdAt: 'desc' }],
      findMany: async (args) =>
        (await this.prisma.user.findMany({ ...args, omit: OMIT_PASSWORD, include: WITH_ROLES })).map(flattenRoles),
      count: (args) => this.prisma.user.count(args),
    });
  }

  async findOne(id: string) {
    try {
      return flattenRoles(
        await this.prisma.user.findUniqueOrThrow({ where: { id }, omit: OMIT_PASSWORD, include: WITH_ROLES }),
      );
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  async update(id: string, { password, roleIds, workingHours, ...dto }: UpdateUserDto) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { orgId: true, status: true, roles: { select: { role: { select: { isSystem: true } } } } },
    });
    if (!current) throw new NotFoundException('User not found');

    const newRoles = roleIds ? await this.findRolesInOrg(roleIds, current.orgId) : undefined;
    const isOwner = current.roles.some(({ role }) => role.isSystem);
    const losesOwner = newRoles ? !newRoles.some((role) => role.isSystem) : false;
    if (isOwner && current.status === 'active' && losesOwner) {
      await this.assertAnotherOwner(id, current.orgId);
    }

    try {
      return flattenRoles(
        await this.prisma.user.update({
          where: { id },
          data: {
            ...dto,
            ...(workingHours ? { workingHours: toWorkingHoursJson(workingHours) } : {}),
            ...(password !== undefined ? { password: await hashPassword(password) } : {}),
            // The given list replaces the user's roles entirely.
            ...(roleIds ? { roles: { deleteMany: {}, create: roleIds.map((roleId) => ({ roleId })) } } : {}),
          },
          omit: OMIT_PASSWORD,
          include: WITH_ROLES,
        }),
      );
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  async remove(id: string) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { orgId: true, status: true, roles: { select: { role: { select: { isSystem: true } } } } },
    });
    if (current?.roles.some(({ role }) => role.isSystem) && current.status === 'active') {
      await this.assertAnotherOwner(id, current.orgId);
    }

    try {
      return await this.prisma.user.delete({ where: { id }, omit: OMIT_PASSWORD });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  private async findRolesInOrg(roleIds: string[], orgId: string) {
    const roles = await this.prisma.role.findMany({
      where: { id: { in: roleIds }, orgId },
      select: { id: true, isSystem: true },
    });
    if (roles.length !== new Set(roleIds).size) {
      throw new BadRequestException('Every role must belong to this organization');
    }
    return roles;
  }

  private async assertAnotherOwner(userId: string, orgId: string) {
    const otherOwners = await this.prisma.user.count({
      where: { orgId, id: { not: userId }, status: 'active', ...OWNER_FILTER },
    });
    if (otherOwners === 0) {
      throw new ConflictException('An organization must keep at least one active owner');
    }
  }
}
