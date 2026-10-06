import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

/**
 * "Something changed for this organization" — the push side of the live screens.
 *
 * The dashboard used to answer "has anything arrived?" by asking every few
 * seconds. It is the wrong question to ask repeatedly, because the ingest path
 * already knows the answer the instant a webhook lands. This bus is that
 * knowledge, published to whoever is watching.
 *
 * Deliberately NOT a data channel. An event says only *that* something changed
 * and roughly what; the browser then refetches through the normal guarded
 * endpoints. Two reasons that matters:
 *
 *  - Authorization stays in one place. Streaming rows would mean re-deriving,
 *    on this path, every tenancy and field-visibility rule the controllers
 *    already enforce — and a leak here would be silent.
 *  - A missed event costs a delay, not data. Anything that drops an event
 *    (reconnect, deploy, the caveat below) is covered by the polling fallback,
 *    because the refetch is the same one the poll does.
 *
 * SCALING CAVEAT — read before running more than one instance.
 * This is an in-process Subject, so it only reaches browsers connected to THIS
 * instance. With two or more API processes behind a load balancer, a lead
 * ingested on instance A does not notify a browser streaming from instance B.
 * The consequence is bounded and not data loss: that browser's polling fallback
 * still picks the lead up within its backoff ceiling (60s by default) instead of
 * in under a second. Making it exact means a shared fanout — Postgres
 * LISTEN/NOTIFY is the natural choice here, since we already have the database
 * and it needs no new infrastructure. `publish()` is the single seam that would
 * change.
 */

export type LiveEventType = 'delivery.received' | 'lead.created' | 'lead.assigned';

export interface LiveEvent {
  organizationId: string;
  type: LiveEventType;
  /** Lets a screen watching one form ignore traffic belonging to another. */
  leadSourceId: string | null;
  /** ISO 8601. The browser uses it only for display and ordering. */
  at: string;
}

@Injectable()
export class EventsBus {
  private readonly logger = new Logger(EventsBus.name);
  private readonly stream = new Subject<LiveEvent>();

  /**
   * Never throws.
   *
   * Every caller is on the ingest or worker path, where the durable write has
   * already succeeded. Failing to tell a browser about it is a cosmetic problem;
   * turning that into an exception would roll back — or dead-letter — work that
   * actually completed.
   */
  publish(event: Omit<LiveEvent, 'at'> & { at?: string }): void {
    try {
      this.stream.next({ ...event, at: event.at ?? new Date().toISOString() });
    } catch (err) {
      this.logger.warn(`Dropped a live event: ${String(err)}`);
    }
  }

  /** Scoped at the source: a subscriber is never handed another tenant's events. */
  forOrganization(organizationId: string): Observable<LiveEvent> {
    return this.stream.pipe(filter((e) => e.organizationId === organizationId));
  }
}
