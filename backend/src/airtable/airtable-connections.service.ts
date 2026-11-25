import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Integration, IntegrationProvider, IntegrationStatus } from '@prisma/client';
import { httpError } from '@/common/errors/app-error';
import { SecretBoxService } from '@/common/service/secret-box.service';
import { aad } from '@/common/utils/crypto';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService, REAUTH_REQUIRED, type CredentialErrors } from '@/connections/connections.service';
import type { IntegrationEnv } from '@/common/utils/interface';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { AirtableClient } from './airtable.client';
import { AirtableApiError, REQUIRED_SCOPES, permissionsOf, readConnectionConfig, type AirtablePermissions } from './types';

export type { SessionIdentity };

/**
 * Airtable as a connection, and reading with it. Connecting, refreshing and
 * disconnecting are ConnectionsService's ("airtable" in Nango, which rotates
 * the refresh token). What the grant may do is integrations.config.scopes,
 * exactly as Airtable's whoami reported them; every guard reads it.
 *
 * An organization may connect several Airtable accounts. Bases and tables are
 * chosen afterwards, one lead source each — connecting imports nothing.
 */

/**
 * How Airtable's client reports a refused credential. A SCOPE_MISSING is
 * deliberately not a reauthorization: a connection without schema.bases:write
 * works, it just cannot create columns.
 */
const AIRTABLE_ERRORS: CredentialErrors = {
  unauthorized: (e) => e instanceof AirtableApiError && e.kind === 'UNAUTHORIZED',
  reauth: (e) => (e instanceof AirtableApiError && e.kind === 'REAUTH' ? REAUTH_REQUIRED : null),
  reauthError: (message) => new AirtableApiError('REAUTH', message, 401),
  unavailableError: (message, status) => new AirtableApiError('UNAVAILABLE', message, status),
};

/** Everything the connection card shows. Never a token. */
export interface AirtableConnectionDTO {
  id: string;
  /** The Airtable user whose account this is. */
  accountId: string | null;
  accountEmail: string | null;
  status: IntegrationStatus;
  permissions: AirtablePermissions;
  scopes: string[];
  /** Scopes this deployment asked for but Airtable did not grant. */
  missingScopes: string[];
  /** When the grant lapses if never used again. Null: Nango keeps it refreshed. */
  refreshExpiresAt: string | null;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  connectedAt: Date;
}

@Injectable()
export class AirtableConnectionsService implements OnModuleInit {
  constructor(
    private readonly client: AirtableClient,
    private readonly secrets: SecretBoxService,
    private readonly connections: ConnectionsService,
    private readonly config: ConfigService<IntegrationEnv, true>,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    this.connections.register({
      key: 'airtable',
      provider: IntegrationProvider.airtable,
      label: 'Airtable',
      description: 'Two-way sync leads with your Airtable bases.',
      category: 'leads',
      auth: 'oauth',
      multiple: true,
      impact: 'Leads are not syncing with Airtable.',
      unavailable: () => {
        if (!this.config.get('AIRTABLE_ENABLED', { infer: true })) return 'Airtable is switched off on this server.';
        const missing = this.client.missingRequiredRequests();
        return missing.length ? `AIRTABLE_SCOPES must request ${missing.join(', ')} — Airtable cannot be read without it.` : null;
      },
      identify: async (token) => {
        const account = await this.client.identify(token);
        // whoami is the authority on what was granted.
        const missing = REQUIRED_SCOPES.filter((scope) => !account.scopes.includes(scope));
        if (missing.length) {
          throw new ConnectionRefused(400, 'AIRTABLE_SCOPE_NOT_GRANTED', `Airtable did not grant ${missing.join(', ')}. Connect again and approve every requested permission.`);
        }
        const scopes = [...account.scopes].sort();
        return { accountId: account.userId, email: account.email, name: account.email, config: { scopes, refreshExpiresAt: null }, audit: { scopes } };
      },
      // First, while the grant still works: once it is forgotten Airtable cannot be
      // asked to stop, and a live notification target would sit in the owner's base
      // pointing at us for the rest of its seven days.
      beforeDisconnect: async (row) => {
        const { AirtableSourcesService } = await import('./airtable-sources.service');
        await this.moduleRef.get(AirtableSourcesService, { strict: false }).releaseWebhooks(row.orgId, row.id);
      },
      view: (row) => {
        const dto = this.toDTO(row);
        return { permissions: dto.permissions, missingScopes: dto.missingScopes };
      },
    });
  }

  async list(orgId: string): Promise<AirtableConnectionDTO[]> {
    return (await this.connections.rows(orgId, 'airtable')).map((row) => this.toDTO(row));
  }

  /** One connection, only if it belongs to the caller's organization: another's id is simply not found. */
  async mustFind(orgId: string, id: string): Promise<Integration> {
    const row = await this.connections.find(orgId, id, 'airtable');
    if (!row) throw httpError(404, 'AIRTABLE_NOT_CONNECTED', 'That Airtable connection does not exist.');
    return row;
  }

  /** What this connection may do, from the scopes Airtable granted it. */
  async permissions(orgId: string, id: string): Promise<AirtablePermissions> {
    return permissionsOf(readConnectionConfig((await this.mustFind(orgId, id)).config).scopes);
  }

  toDTO(row: Integration): AirtableConnectionDTO {
    const { scopes, refreshExpiresAt } = readConnectionConfig(row.config);
    return {
      id: row.id,
      accountId: row.externalAccountId,
      accountEmail: row.accountEmail,
      status: row.status,
      permissions: permissionsOf(scopes),
      scopes,
      missingScopes: this.client.requestedScopes.filter((s) => !scopes.includes(s)),
      refreshExpiresAt,
      lastVerifiedAt: row.lastVerifiedAt,
      lastErrorCode: row.lastErrorCode,
      connectedAt: row.createdAt,
    };
  }

  /** Runs `fn` with a valid access token for this connection (see ConnectionsService.withCredential). */
  withAccessToken<T>(orgId: string, credentialId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    if (!credentialId) return Promise.reject(new AirtableApiError('REAUTH', 'No connection', 0));
    return this.connections.withCredential(orgId, credentialId, 'airtable', AIRTABLE_ERRORS, (token) => fn(token));
  }

  /**
   * Seals a webhook's MAC secret to the lead source it belongs to. Airtable
   * returns that secret exactly once, at creation, so it is sealed immediately
   * or lost — and the AAD means the ciphertext cannot be moved to another
   * source's row to make its signatures verify.
   */
  sealForSource(orgId: string, sourceId: string, secret: string): string {
    return this.secrets.seal(secret, aad.signingSecret(orgId, sourceId));
  }

  /** The webhook MAC secret for a source; null when it cannot be opened. */
  openForSource(orgId: string, sourceId: string, sealed: string | null): string | null {
    if (!sealed) return null;
    try {
      return this.secrets.open(sealed, aad.signingSecret(orgId, sourceId));
    } catch {
      return null;
    }
  }

  /** Airtable failures in the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(e: unknown): unknown {
    if (!(e instanceof AirtableApiError)) return e;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'AIRTABLE_REAUTH_REQUIRED', 'Airtable access was revoked or has expired. Reconnect Airtable to continue.');
      case 'SCOPE_MISSING':
        return httpError(403, 'AIRTABLE_SCOPE_NOT_GRANTED', 'Airtable did not grant this permission. Reconnect Airtable and approve it.');
      case 'RATE_LIMITED':
        return httpError(429, 'AIRTABLE_RATE_LIMITED', 'Airtable is rate-limiting requests. Try again in a minute.');
      case 'UNAVAILABLE':
        return httpError(502, 'AIRTABLE_UNAVAILABLE', 'Airtable did not respond. Try again shortly.');
      case 'NOT_FOUND':
        return httpError(404, 'AIRTABLE_NOT_FOUND', `Airtable could not find that: ${e.message}`);
      default:
        return httpError(502, 'AIRTABLE_REQUEST_FAILED', `Airtable refused the request: ${e.message}`);
    }
  }
}
