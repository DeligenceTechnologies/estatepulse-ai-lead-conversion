import type { Integration, IntegrationProvider, Prisma } from '@prisma/client';
import type { Feature } from '@/billing/billing-plans';
import type { NangoIntegration } from '@/nango/nango.constants';

export type ConnectionCategory = 'leads' | 'crm' | 'calendar' | 'calling';

/** Who an account is, read with the credential Nango just handed over. */
export interface ConnectedAccount {
  /** The provider's stable id for the account: the same account connecting again updates the same row. */
  accountId: string;
  email?: string | null;
  name?: string | null;
  /** Shown instead of the credential, e.g. a masked API key ("KEY01…9f2a"). */
  preview?: string | null;
  /** Provider setup kept on the row (granted scopes, workspace, …), merged over what is there. */
  config?: Prisma.InputJsonObject;
  /** Extra facts for the audit log. Never a credential. */
  audit?: Record<string, unknown>;
}

/**
 * A connection the provider's rules refuse (missing scope, not an admin,
 * another account already connected). The Nango connection is handed back
 * unless a live row already uses it; `revokeAtProvider` also revokes the
 * grant at the provider, for an account that must not stay authorized.
 */
export class ConnectionRefused extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly revokeAtProvider = false,
  ) {
    super(message);
    this.name = 'ConnectionRefused';
  }
}

export interface ConnectionContext {
  orgId: string;
  /** Null when the connection is finished from Nango's webhook with no member to credit. */
  userId: string | null;
  row: Integration;
  account: ConnectedAccount;
  /** The same account was connected here before (a reconnect, or one disconnected earlier). */
  reconnected: boolean;
  tx: Prisma.TransactionClient;
}

export interface DisconnectContext {
  orgId: string;
  userId: string;
  row: Integration;
  /** The person confirmed a disconnect that the first try warned about. */
  force: boolean;
  tx: Prisma.TransactionClient;
}

/**
 * Everything one provider adds to the shared connect flow. Consent screens,
 * key entry, credential storage and refresh are Nango's; the session, the
 * organization check, the row, one-account-per-organization, reattaching lead
 * sources, audit, broken-connection emails and disconnect are
 * ConnectionsService's. A definition only says who the account is and what
 * the provider's own data needs when it connects or goes.
 */
export interface ConnectionDefinition {
  key: NangoIntegration;
  provider: IntegrationProvider;
  label: string;
  /** One line for the card. */
  description: string;
  category: ConnectionCategory;
  auth: 'oauth' | 'apiKey';
  /** Several accounts per organization (Telnyx). Otherwise a second account is refused. */
  multiple?: boolean;
  /** The plan feature an organization needs to connect it. */
  feature?: Feature;
  /** New rows wait as "needs setup" until the provider's own setup is saved (Telnyx: number and public key). */
  needsSetup?: boolean;
  /** What stops working while it is broken, for the owners' email. */
  impact: string;

  /** Why it cannot be connected on this server (a flag is off, a setting is missing), or null. */
  unavailable(): string | null;

  /** Reads the account with the credential (access token or API key). Throws ConnectionRefused to refuse it. */
  identify(credential: string, raw: Record<string, unknown>): Promise<ConnectedAccount>;

  /** Inside the connect transaction, after the row is written. What it returns goes into the audit entry. */
  connected?(ctx: ConnectionContext): Promise<Record<string, unknown> | void>;
  /** After the connect transaction commits. */
  afterConnected?(row: Integration, userId: string | null): Promise<void>;

  /** Before the disconnect transaction, while the credential still works (remove provider webhooks). Best effort. */
  beforeDisconnect?(row: Integration, credential: string | null): Promise<void>;
  /** Inside the disconnect transaction. Throw ConnectionRefused to refuse (e.g. forms still use it). */
  disconnecting?(ctx: DisconnectContext): Promise<Record<string, unknown> | void>;
  /** After commit, best effort: revoke the grant or uninstall the app at the provider. */
  revoke?(credential: string, row: Integration | null): Promise<void>;

  /** Extra work when the connection breaks or recovers (the calendar parks itself). */
  broken?(row: Integration): Promise<void>;
  recovered?(row: Integration): Promise<void>;

  /** Provider-specific fields for the card (granted permissions, workspace, phone number). */
  view?(row: Integration): Record<string, unknown>;
}
