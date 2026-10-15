import { Controller, Header, Sse, type MessageEvent } from '@nestjs/common';
import { NEVER, Observable, concat, exhaustMap, filter, interval, map, merge, of, takeUntil } from 'rxjs';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { AuthContext } from '@/auth/auth.types';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from './events.bus';

const HEARTBEAT_MS = 25_000;
const SESSION_RECHECK_MS = 60_000;

@Controller('v1/events')
export class EventsController {
  constructor(
    private readonly bus: EventsBus,
    private readonly prisma: PrismaService,
  ) {}

  @Sse()
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  stream(@CurrentAuth() auth: AuthContext): Observable<MessageEvent> {
    const ready = of<MessageEvent>({ data: { type: 'ready', at: new Date().toISOString() } });
    const changes = this.bus
      .forOrganization(auth.organizationId)
      .pipe(map(({ organizationId: _org, ...event }): MessageEvent => ({ data: event })));
    const heartbeat = interval(HEARTBEAT_MS).pipe(
      map((): MessageEvent => ({ data: { type: 'ping', at: new Date().toISOString() } })),
    );
    // The stream outlives the request that opened it, so a logout or a
    // revoked session ends it here instead of at the next reconnect.
    const sessionEnded = auth.sessionId
      ? interval(SESSION_RECHECK_MS).pipe(
          exhaustMap(() => this.sessionLive(auth.sessionId).catch(() => true)),
          filter((live) => !live),
        )
      : NEVER;
    return concat(ready, merge(changes, heartbeat)).pipe(takeUntil(sessionEnded));
  }

  private async sessionLive(sessionId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findUnique({
      where: { id: sessionId },
      select: { revokedAt: true, expiresAt: true },
    });
    return Boolean(session && !session.revokedAt && session.expiresAt.getTime() > Date.now());
  }
}
