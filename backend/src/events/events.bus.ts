import { Injectable, Logger } from '@nestjs/common';
import { Observable, Subject, filter } from 'rxjs';

export type LiveEventType = 'delivery.received' | 'lead.created' | 'lead.assigned';

export interface LiveEvent {
  organizationId: string;
  type: LiveEventType;
  leadSourceId: string | null;
  at: string;
}

/** In-process fan-out of "something changed" hints; screens refetch on them. */
@Injectable()
export class EventsBus {
  private readonly logger = new Logger(EventsBus.name);
  private readonly stream = new Subject<LiveEvent>();

  publish(event: Omit<LiveEvent, 'at'>): void {
    try {
      this.stream.next({ ...event, at: new Date().toISOString() });
    } catch (error) {
      this.logger.warn(`Dropped a live event: ${String(error)}`);
    }
  }

  forOrganization(organizationId: string): Observable<LiveEvent> {
    return this.stream.pipe(filter((event) => event.organizationId === organizationId));
  }
}
