import { Global, Module } from '@nestjs/common';
import { PrismaService, TENANT_PRISMA, type GuardedPrisma } from './prisma.service';

/**
 * Two clients, one connection pool.
 *
 * `TENANT_PRISMA` is the guarded client and is what almost everything should
 * inject: it refuses any read or write against a tenant-scoped table that has
 * no organization id (or globally-unique key) in its `where`. There is no RLS —
 * the API connects as a privileged role — so that extension *is* the isolation
 * boundary between customers.
 *
 * `PrismaService` is the unguarded client underneath it. Injecting it directly
 * is a deliberate, reviewable act, and is correct for exactly one category of
 * work: system processes that sweep every tenant by design (the delivery worker
 * and the lead watcher). Every such injection carries a comment saying so.
 *
 * `$extends` returns a wrapper around the same engine and connection pool, so
 * having both costs nothing at the database.
 */
@Global()
@Module({
  providers: [
    PrismaService,
    {
      provide: TENANT_PRISMA,
      inject: [PrismaService],
      useFactory: (prisma: PrismaService): GuardedPrisma => prisma.withTenancyGuard(),
    },
  ],
  exports: [PrismaService, TENANT_PRISMA],
})
export class PrismaModule {}
