import { ConflictException, ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { TENANT_PRISMA, type GuardedPrisma } from '@/common/prisma/prisma.service';
import { rethrowPrismaError } from '@/common/prisma/prisma-errors';
import { paginate } from '@/common/pagination/paginate';
import type { ListQuery } from '@/common/pagination/pagination.types';
import type { AuthContext } from '@/auth/auth.types';
import { CreateRoleDto } from './dto/create-role.dto';
import { UpdateRoleDto } from './dto/update-role.dto';
import { PERMISSION_GROUPS } from './permissions';

const WITH_USER_COUNT = { _count: { select: { users: true } } } as const;

/** Roles of the caller's organization; the tenancy guard scopes every query. */
@Injectable()
export class RoleService {
  constructor(@Inject(TENANT_PRISMA) private readonly prisma: GuardedPrisma) {}

  listPermissions() {
    return PERMISSION_GROUPS;
  }

  /** `search` matches name and description. */
  findAll(query: ListQuery) {
    return paginate(query, {
      where: {} as Prisma.RoleWhereInput,
      searchFields: ['name', 'description'],
      filters: {
        isSystem: { type: 'boolean' },
        createdAt: { type: 'dateRange' },
      },
      sortableFields: ['name', 'createdAt'] as const,
      defaultSort: [{ isSystem: 'desc' }, { name: 'asc' }],
      findMany: (args) => this.prisma.role.findMany({ ...args, include: WITH_USER_COUNT }),
      count: (args) => this.prisma.role.count(args),
    });
  }

  async findOne(id: string) {
    const role = await this.prisma.role.findUnique({ where: { id }, include: WITH_USER_COUNT });
    if (!role) throw new NotFoundException('Role not found');
    return role;
  }

  async create(dto: CreateRoleDto, auth: AuthContext) {
    try {
      return await this.prisma.role.create({
        data: { ...dto, orgId: auth.organizationId, isSystem: false },
        include: WITH_USER_COUNT,
      });
    } catch (error) {
      rethrowRoleError(error);
    }
  }

  async update(id: string, dto: UpdateRoleDto) {
    await this.findEditable(id);
    try {
      return await this.prisma.role.update({ where: { id }, data: dto, include: WITH_USER_COUNT });
    } catch (error) {
      rethrowRoleError(error);
    }
  }

  async remove(id: string) {
    const role = await this.findEditable(id);
    if (role._count.users > 0) {
      throw new ConflictException(
        `This role is assigned to ${role._count.users} user(s). Remove it from them first.`,
      );
    }
    try {
      return await this.prisma.role.delete({ where: { id } });
    } catch (error) {
      rethrowRoleError(error);
    }
  }

  private async findEditable(id: string) {
    const role = await this.findOne(id);
    if (role.isSystem) {
      throw new ForbiddenException('The Owner role cannot be modified or deleted');
    }
    return role;
  }
}

function rethrowRoleError(error: unknown): never {
  if (error instanceof Prisma.PrismaClientKnownRequestError) {
    if (error.code === 'P2002') throw new ConflictException('A role with this name already exists');
    // FK violation: users were assigned between the count and the delete.
    if (error.code === 'P2003') throw new ConflictException('This role is still assigned to users');
  }
  rethrowPrismaError(error, 'Role');
}
