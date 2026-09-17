import { Controller, Get } from '@nestjs/common';
import { PrismaService } from './prisma/prisma.service';

interface HealthBody {
  status: string;
  database: string;
  time: string;
}

/**
 * Unauthenticated liveness probe.
 *
 * Unguarded PrismaService on purpose: `SELECT 1` touches no tenant table, and a
 * liveness check must not depend on the tenancy extension being happy.
 */
@Controller()
export class HealthController {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Two paths for one probe. /api/health is the shallow one a load balancer
   * hits; /api/v1/health is the versioned one the dashboard's client calls.
   * Both report database reachability, because an API that answers 200 while
   * its database is gone is worse than one that admits it is degraded.
   */
  // One array, not two stacked @Get decorators — the second would overwrite the
  // first's metadata and only one path would ever register.
  @Get(['api/health', 'api/v1/health'])
  async health(): Promise<HealthBody> {
    let database = 'ok';
    try {
      await this.prisma.$queryRaw`SELECT 1`;
    } catch {
      database = 'unreachable';
    }
    return {
      status: database === 'ok' ? 'ok' : 'degraded',
      database,
      time: new Date().toISOString(),
    };
  }
}
