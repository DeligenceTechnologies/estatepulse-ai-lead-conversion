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

const OMIT_PASSWORD = { password: true } as const;
const WITH_ROLE = { role: { select: { id: true, name: true, isSystem: true } } } as const;

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
    await this.findRoleInOrg(dto.roleId, dto.orgId);

    const password = generatePassword();
    let user;
    try {
      user = await this.prisma.user.create({
        data: { ...dto, password: await hashPassword(password) },
        omit: OMIT_PASSWORD,
        include: WITH_ROLE,
      });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }

    const credentialsEmail = await this.sendCredentials({
      firstName: user.firstName,
      organizationName: organization.name,
      roleName: user.role.name,
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
        roleId: { type: 'uuid', multiple: true },
      },
      sortableFields: ['createdAt'] as const,
      defaultSort: [{ createdAt: 'desc' }],
      findMany: (args) => this.prisma.user.findMany({ ...args, omit: OMIT_PASSWORD, include: WITH_ROLE }),
      count: (args) => this.prisma.user.count(args),
    });
  }

  async findOne(id: string) {
    try {
      return await this.prisma.user.findUniqueOrThrow({ where: { id }, omit: OMIT_PASSWORD, include: WITH_ROLE });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  async update(id: string, { password, ...dto }: UpdateUserDto) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { orgId: true, status: true, role: { select: { isSystem: true } } },
    });
    if (!current) throw new NotFoundException('User not found');

    const newRole = dto.roleId ? await this.findRoleInOrg(dto.roleId, current.orgId) : undefined;
    const losesOwner = newRole ? !newRole.isSystem : false;
    if (current.role.isSystem && current.status === 'active' && losesOwner) {
      await this.assertAnotherOwner(id, current.orgId);
    }

    try {
      return await this.prisma.user.update({
        where: { id },
        data: {
          ...dto,
          ...(password !== undefined ? { password: await hashPassword(password) } : {}),
        },
        omit: OMIT_PASSWORD,
        include: WITH_ROLE,
      });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  async remove(id: string) {
    const current = await this.prisma.user.findUnique({
      where: { id },
      select: { orgId: true, status: true, role: { select: { isSystem: true } } },
    });
    if (current?.role.isSystem && current.status === 'active') {
      await this.assertAnotherOwner(id, current.orgId);
    }

    try {
      return await this.prisma.user.delete({ where: { id }, omit: OMIT_PASSWORD });
    } catch (error) {
      rethrowPrismaError(error, 'User');
    }
  }

  private async findRoleInOrg(roleId: string, orgId: string) {
    const role = await this.prisma.role.findFirst({
      where: { id: roleId, orgId },
      select: { id: true, isSystem: true },
    });
    if (!role) throw new BadRequestException('Role does not belong to this organization');
    return role;
  }

  private async assertAnotherOwner(userId: string, orgId: string) {
    const otherOwners = await this.prisma.user.count({
      where: { orgId, id: { not: userId }, status: 'active', role: { isSystem: true } },
    });
    if (otherOwners === 0) {
      throw new ConflictException('An organization must keep at least one active owner');
    }
  }
}
