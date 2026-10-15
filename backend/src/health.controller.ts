import { Controller, Get } from '@nestjs/common';
import { Public } from '@/auth/decorators/public.decorator';
import { PrismaService } from '@/common/prisma/prisma.service';
import { RedisService } from '@/common/service/redis.service';

const CHECK_TIMEOUT_MS = 2_000;

/** Liveness probe; reports the database and Redis too, since an API without either is degraded, not healthy. */
@Public()
@Controller()
export class HealthController {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  @Get(['health', 'v1/health'])
  async health(): Promise<{ status: string; database: string; redis: string; time: string }> {
    const [database, redis] = await Promise.all([
      check(() => this.prisma.$queryRaw`SELECT 1`),
      this.redis.ping().then((up): Status => (up ? 'ok' : 'unreachable')),
    ]);
    return {
      status: database === 'ok' && redis === 'ok' ? 'ok' : 'degraded',
      database,
      redis,
      time: new Date().toISOString(),
    };
  }
}

type Status = 'ok' | 'unreachable';

async function check(probe: () => Promise<unknown>): Promise<Status> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      probe(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('timeout')), CHECK_TIMEOUT_MS);
      }),
    ]);
    return 'ok';
  } catch {
    return 'unreachable';
  } finally {
    clearTimeout(timer);
  }
}
