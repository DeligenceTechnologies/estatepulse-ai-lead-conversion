import { Prisma } from '@prisma/client';

export const TENANT_SCOPED_MODELS: ReadonlySet<Prisma.ModelName> =
    new Set<Prisma.ModelName>([
      Prisma.ModelName.User,
      Prisma.ModelName.Role,
    ]);

const WHERE_OPERATIONS = new Set([
  'findUnique',
  'findUniqueOrThrow',
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'count',
  'aggregate',
  'groupBy',
  'update',
  'updateMany',
  'updateManyAndReturn',
  'delete',
  'deleteMany',
  'upsert',
]);

const DATA_OPERATIONS = new Set([
  'create',
  'createMany',
  'createManyAndReturn',
  'update',
  'updateMany',
  'updateManyAndReturn',
]);

export class TenancyViolationError extends Error {
  constructor(model: string, operation: string, reason: string) {
    super(`Tenancy guard: ${model}.${operation} ${reason}`);
    this.name = 'TenancyViolationError';
  }
}

type Args = Record<string, unknown>;
type Data = Record<string, unknown>;

export function scopeArgs(
    model: string,
    operation: string,
    args: unknown,
    organizationId: string,
): Args {
  const fail = (reason: string): never => {
    throw new TenancyViolationError(model, operation, reason);
  };

  const assertSameTenant = (
      value: unknown,
      location: string,
  ): void => {
    if (value !== undefined && value !== organizationId) {
      fail(
          `${location}.orgId does not match the current organization`,
      );
    }
  };

  const scopeCreate = (data: unknown): Data => {
    const row = (data ?? {}) as Data;

    if (row.organization !== undefined) {
      fail(
          'must use orgId instead of the organization relation',
      );
    }

    assertSameTenant(row.orgId, 'data');

    return {
      ...row,
      orgId: organizationId,
    };
  };

  const scopeUpdate = (data: unknown): Data => {
    const row = (data ?? {}) as Data;

    if (row.organization !== undefined) {
      fail('may not change the organization of a row');
    }

    assertSameTenant(row.orgId, 'data');

    return row;
  };

  const scoped: Args = {
    ...((args ?? {}) as Args),
  };

  if (WHERE_OPERATIONS.has(operation)) {
    const where = (scoped.where ?? {}) as Args;

    assertSameTenant(where.orgId, 'where');

    scoped.where = {
      ...where,
      orgId: organizationId,
    };
  }

  if (operation === 'upsert') {
    scoped.create = scopeCreate(scoped.create);
    scoped.update = scopeUpdate(scoped.update);
  } else if (DATA_OPERATIONS.has(operation)) {
    if (operation.startsWith('create')) {
      const data = scoped.data;

      scoped.data = Array.isArray(data)
          ? data.map(scopeCreate)
          : scopeCreate(data);
    } else {
      scoped.data = scopeUpdate(scoped.data);
    }
  }

  return scoped;
}