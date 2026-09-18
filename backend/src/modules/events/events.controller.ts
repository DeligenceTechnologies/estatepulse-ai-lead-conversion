import { Controller, Header, Req, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import { Observable, concat, interval, map, merge, of } from 'rxjs';
import { TenantGuard, type TenantRequest } from '../../common/guards/tenant.guard';
import { EventsBus } from './events.bus';

/**
 * The live event stream the dashboard listens on instead of polling.
 *
 * Guarded by the ordinary TenantGuard, which means this route authenticates with
 * the same `Authorization: Bearer` header as every other call. That is only
 * possible because the browser reads it with `fetch` rather than `EventSource` —
 * `EventSource` cannot set headers, and the usual workaround of putting the
 * session token in the query string writes a live credential into every access
 * log, proxy log and browser history entry between here and the user. See
 * frontend/src/lib/liveEvents.ts.
 *
 * Excluded from the request rate limiter in server.ts: one connection that stays
 * open for hours is not request volume, and counting it would mean a reconnect
 * loop could lock a user out of their own dashboard.
 */
@Controller('api/v1/events')
@UseGuards(TenantGuard)
export class EventsController {
  constructor(private readonly bus: EventsBus) {}

  @Sse()
  // nginx and several managed proxies buffer proxied responses by default, which
  // holds events until enough bytes accumulate — the stream then appears to work
  // in development and to hang in production. This header opts that off.
  @Header('X-Accel-Buffering', 'no')
  @Header('Cache-Control', 'no-cache, no-transform')
  stream(@Req() req: TenantRequest): Observable<MessageEvent> {
    const organizationId = req.tenant.organizationId;

    // Sent immediately so the client can distinguish "connected and quiet" from
    // "still connecting". Without it, a stream that never fires an event is
    // indistinguishable from one that never opened.
    const ready = of<MessageEvent>({ data: { type: 'ready', at: new Date().toISOString() } });

    const changes = this.bus
      .forOrganization(organizationId)
      .pipe(map((event): MessageEvent => ({ data: event })));

    /*
     * Heartbeat.
     *
     * Idle connections are reaped by load balancers — 60 seconds is a common
     * default — and the reap looks exactly like a clean close, so the client
     * reconnects on a timer forever without ever knowing why. 25s stays
     * comfortably inside that.
     *
     * A `data` frame rather than an SSE comment (`:ping`) because @Sse()
     * serializes objects for us; the client drops it by type. The cost is a few
     * dozen bytes a minute per open tab.
     */
    const heartbeat = interval(25_000).pipe(
      map((): MessageEvent => ({ data: { type: 'ping', at: new Date().toISOString() } })),
    );

    return concat(ready, merge(changes, heartbeat));
  }
}
