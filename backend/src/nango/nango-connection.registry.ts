import { Injectable } from '@nestjs/common';
import type { NangoIntegration } from './nango.constants';

/** The connection a webhook is about, already checked to be a member of its organization. */
export interface NangoConnectionRef {
  organizationId: string;
  userId: string;
  connectionId: string;
}

/**
 * What each provider module does when Nango reports on one of its connections.
 * The business rules (which row, which lead sources, who is emailed) stay in
 * the provider's own service; this is only the routing. Every method must be
 * idempotent: Nango retries a webhook it did not see answered.
 */
export interface NangoConnectionHandler {
  /**
   * A connection was created or re-authorized. Finish it if the browser never
   * did (the tab was closed mid-flow); do nothing if it is already linked and
   * working.
   */
  reconcile(ref: NangoConnectionRef): Promise<void>;
  /** Nango could not refresh the grant: park the connection and tell the owners. */
  refreshFailed(connectionId: string): Promise<void>;
  /** A refresh worked again after failing: clear what refreshFailed parked. */
  refreshRecovered(connectionId: string): Promise<void>;
  /** The connection was deleted in Nango (dashboard or API): stop using it. */
  deleted(connectionId: string): Promise<void>;
}

/**
 * A provider webhook Nango received with the provider's own signature (which
 * Nango checks, using the app credentials it holds) and forwarded to us,
 * signed with Nango's key. `payload` is the provider's body, unchanged.
 * Throwing makes Nango retry the delivery.
 */
export type NangoForwardHandler = (forwarded: { connectionId: string | null; payload: unknown }) => Promise<void>;

@Injectable()
export class NangoConnectionRegistry {
  private readonly handlers = new Map<NangoIntegration, NangoConnectionHandler>();
  private readonly forwards = new Map<NangoIntegration, NangoForwardHandler>();

  registerForward(integration: NangoIntegration, handler: NangoForwardHandler): void {
    this.forwards.set(integration, handler);
  }

  forward(integration: NangoIntegration): NangoForwardHandler | null {
    return this.forwards.get(integration) ?? null;
  }

  register(integration: NangoIntegration, handler: NangoConnectionHandler): void {
    this.handlers.set(integration, handler);
  }

  get(integration: NangoIntegration): NangoConnectionHandler | null {
    return this.handlers.get(integration) ?? null;
  }
}
