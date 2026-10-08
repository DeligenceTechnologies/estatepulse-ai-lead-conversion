import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PrismaClient } from '@prisma/client';
import { TenantContext } from './tenant-context';
import { TENANT_SCOPED_MODELS, TenancyViolationError, scopeArgs } from './tenant-scope';

type LogLevel = 'warn' | 'error' | 'query';

@Injectable()
export class PrismaService
    extends PrismaClient<Prisma.PrismaClientOptions, LogLevel>
    implements OnModuleInit, OnModuleDestroy
{
  private readonly logger = new Logger(PrismaService.name);

  constructor(config: ConfigService) {
    // SQL is logged only with LOG_LEVEL=debug; never in normal production logs.
    const logQueries = config.get<string>('LOG_LEVEL') === 'debug';

    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
        ...(logQueries
            ? [{ emit: 'event' as const, level: 'query' as const }]
            : []),
      ],
    });

    this.$on('warn', (event) => {
      this.logger.warn(event.message);
    });

    this.$on('error', (event) => {
      this.logger.error(event.message);
    });

    if (logQueries) {
      this.$on('query', (event) => {
        this.logger.debug(
            `[sql] ${event.duration}ms ${event.query.replace(/\s+/g, ' ').slice(0, 140)}`,
        );
      });
    }
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  withTenancyGuard() {
    return this.$extends({
      name: 'tenancy-guard',

      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!TENANT_SCOPED_MODELS.has(model as Prisma.ModelName)) {
              return query(args);
            }

            const organizationId = TenantContext.organizationId();

            if (!organizationId) {
              throw new TenancyViolationError(
                  model,
                  operation,
                  'was called outside a tenant context',
              );
            }

            return query(
                scopeArgs(model, operation, args, organizationId) as typeof args,
            );
          },
        },
      },
    });
  }
}

export type GuardedPrisma = ReturnType<PrismaService['withTenancyGuard']>;

export const TENANT_PRISMA = Symbol('TENANT_PRISMA');

export { Prisma };