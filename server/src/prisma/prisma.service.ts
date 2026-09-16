import { INestApplication, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';

/**
 * Models that carry `organization_id` and must never be queried across tenants.
 * `Organization` itself is absent — it is the tenancy root, looked up by id/slug.
 */
const TENANT_SCOPED = new Set<string>([
  'api_keys',
  'agent_profiles',
  'agent_territories',
  'agent_availability',
  'lead_sources',
  'provider_credentials',
  'lead_source_fields',
  'lead_source_field_mappings',
  'webhook_events',
  'webhook_subscriptions',
  'leads',
  'lead_submissions',
  'lead_assignments',
  'conversations',
  'messages',
  'voice_calls',
  'appointments',
  'calendar_connections',
  'followup_sequences',
  'sequence_steps',
  'sequence_enrollments',
  'integrations',
  'audit_logs',
  'domain_events',
  'organization_members',
]);

/** Operations that read or write rows and therefore need a tenant predicate. */
const GUARDED_OPS = new Set<string>([
  'findFirst',
  'findFirstOrThrow',
  'findMany',
  'findUnique',
  'findUniqueOrThrow',
  'update',
  'updateMany',
  'delete',
  'deleteMany',
  'count',
  'aggregate',
  'groupBy',
]);

/**
 * Globally-unique selectors. Addressing a row by one of these cannot leak across
 * tenants by construction, so they satisfy the guard on their own.
 */
const GLOBAL_UNIQUE_KEYS = [
  'id',
  'organization_id',
  'key_hash',
  'ingest_token_hash',
  'webhook_event_id',
  'lead_source_id_field_key',
  'lead_source_id_source_field_key_target_field',
] as const;

function hasTenantPredicate(where: unknown): boolean {
  if (!where || typeof where !== 'object') return false;
  const w = where as Record<string, unknown>;

  for (const key of GLOBAL_UNIQUE_KEYS) {
    if (w[key] !== undefined) return true;
  }

  for (const key of ['AND', 'OR'] as const) {
    const branch = w[key];
    if (Array.isArray(branch) && branch.some(hasTenantPredicate)) return true;
  }
  return false;
}

/**
 * Prisma client with a tenancy guard.
 *
 * There is no RLS yet — the API connects as a privileged role — so this
 * extension *is* the isolation boundary. It throws if a tenant-scoped model is
 * read or written without an `organizationId` (or a globally-unique key) in the
 * `where`.
 *
 * It is deliberately added in week one: this is ~40 lines now, versus auditing
 * every call site later. It is the difference between "multi-tenant schema" and
 * "multi-tenant system".
 *
 * Note that the demo's fake contract put `organization_key` in the request BODY
 * (see src/components/modals/WebhookSimulatorModal.tsx). That is
 * attacker-controlled and would let anyone write into any tenant — the org must
 * always be resolved from the presented credential.
 */
@Injectable()
export class PrismaService extends PrismaClient implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PrismaService.name);

  constructor() {
    super({
      log: [
        { emit: 'event', level: 'warn' },
        { emit: 'event', level: 'error' },
      ],
    });
  }

  async onModuleInit(): Promise<void> {
    await this.$connect();
  }

  async onModuleDestroy(): Promise<void> {
    await this.$disconnect();
  }

  /** Call once at bootstrap; returns the guarded client used everywhere. */
  withTenancyGuard() {
    return this.$extends({
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (model && TENANT_SCOPED.has(model) && GUARDED_OPS.has(operation)) {
              const where = (args as { where?: unknown }).where;
              if (!hasTenantPredicate(where)) {
                throw new Error(
                  `Tenancy guard: ${model}.${operation} was called without an organizationId ` +
                    'or a globally-unique key in its where clause. Scope the query, or use ' +
                    '$queryRaw explicitly if this is a deliberate cross-tenant admin operation.',
                );
              }
            }
            return query(args);
          },
        },
      },
    });
  }

  async enableShutdownHooks(app: INestApplication): Promise<void> {
    process.on('beforeExit', () => {
      void app.close();
    });
  }
}

export type GuardedPrisma = ReturnType<PrismaService['withTenancyGuard']>;
export { Prisma };
