import { Injectable, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import {
  ConnectionMethod,
  ConsentStatus,
  CrmSyncRunKind,
  CrmSyncRunStatus,
  IngestStatus,
  IntegrationProvider,
  LeadSourceProvider,
  MappingStatus,
  QueueState,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { httpError } from '@/common/errors/app-error';
import { ConnectionRefused } from '@/connections/connection-definition';
import { ConnectionsService, type CredentialErrors } from '@/connections/connections.service';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { CrmRegistry } from './crm-registry';
import { CrmApiError, type CrmAdapter } from './types';

export type { SessionIdentity };

/**
 * A CRM account as a connection, and calling the CRM with it.
 *
 * Connecting, refreshing and disconnecting are ConnectionsService's. What a
 * CRM adds: connecting creates (or, on a reconnect, reuses) its import lead
 * source and queues the first import; disconnecting pauses that source and
 * cancels queued work, keeps every lead, and uninstalls the app at the CRM.
 *
 * Policy: one live CRM account per organization, and a CRM account live in at
 * most one organization. Both are partial unique indexes.
 */

/** The integrations.provider value a CRM adapter's grant is stored under. */
export function integrationProviderOf(adapter: CrmAdapter): IntegrationProvider {
  if (adapter.provider === LeadSourceProvider.HUBSPOT) return IntegrationProvider.hubspot;
  throw new Error(`No integration provider for CRM ${adapter.provider}`);
}

/** The lead_sources.provider value of a CRM adapter's import. */
export function sourceProviderOf(adapter: CrmAdapter): LeadSourceProvider {
  if (adapter.provider === LeadSourceProvider.HUBSPOT) return LeadSourceProvider.HUBSPOT;
  throw new Error(`No lead source provider for CRM ${adapter.provider}`);
}

/** A 403 REAUTH is the CRM refusing a scope it was not granted; anything else is a dead grant. */
const CRM_ERRORS: CredentialErrors = {
  unauthorized: (e) => e instanceof CrmApiError && e.kind === 'UNAUTHORIZED',
  reauth: (e) => (e instanceof CrmApiError && e.kind === 'REAUTH' ? (e.status === 403 ? 'CRM_SCOPE_NOT_GRANTED' : 'REAUTH_REQUIRED') : null),
  reauthError: (message) => new CrmApiError('REAUTH', message, 401),
  unavailableError: (message, status) => new CrmApiError('UNAVAILABLE', message, status),
};

@Injectable()
export class CrmConnectionsService implements OnModuleInit {
  constructor(
    private readonly connections: ConnectionsService,
    private readonly crms: CrmRegistry,
    private readonly moduleRef: ModuleRef,
  ) {}

  onModuleInit(): void {
    for (const adapter of this.crms.active()) this.register(adapter);
  }

  private register(adapter: CrmAdapter): void {
    const name = adapter.label.displayName;
    const sourceProvider = sourceProviderOf(adapter);
    this.connections.register({
      key: adapter.nangoIntegration,
      provider: integrationProviderOf(adapter),
      label: name,
      description: `Import contacts from ${name} and keep them in sync.`,
      category: 'crm',
      auth: 'oauth',
      impact: `Leads are not syncing with ${name}.`,
      unavailable: () => (adapter.isConfigured() ? null : `${name} is not configured on this server.`),
      identify: async (token) => {
        const account = await adapter.identify(token);
        const granted = new Set(account.scopes ?? []);
        const missing = adapter.requiredScopes.filter((scope) => !granted.has(scope));
        if (missing.length) {
          throw new ConnectionRefused(400, 'CRM_SCOPE_NOT_GRANTED', `${name} did not grant ${missing.join(', ')}. Connect again and approve every requested permission.`);
        }
        return {
          accountId: account.externalAccountId,
          email: account.userEmail,
          name: account.accountName,
          audit: { provider: adapter.provider, authorizedBy: account.userEmail, scopes: [...granted].sort() },
        };
      },
      connected: async ({ tx, orgId, userId, row, account }) => {
        // The import source for this account: reused on a reconnect, so its tracked records — and their leads — carry on.
        const name = `${adapter.label.displayName} · ${account.name ?? account.accountId}`.slice(0, 100);
        const prior = await tx.leadSource.findFirst({
          where: {
            orgId,
            provider: sourceProvider,
            connectionMethod: ConnectionMethod.SYNC,
            externalFormId: account.accountId,
            archivedAt: null,
          },
          select: { id: true, remoteSyncedAt: true },
        });
        const sourceId = prior?.id ?? randomUUID();
        const sourceState = {
          integrationId: row.id,
          isActive: true,
          ingestStatus: IngestStatus.ACTIVE,
          mappingStatus: MappingStatus.CONFIGURED,
          externalFormName: account.name ?? null,
          remoteErrorCode: null,
          remoteErrorMessage: null,
          syncFailures: 0,
        };
        if (prior) {
          await tx.leadSource.update({ where: { id: sourceId }, data: { ...sourceState, name } });
        } else {
          await tx.leadSource.create({
            data: {
              id: sourceId,
              orgId,
              name,
              code: `${adapter.provider.toLowerCase()}-${account.accountId}`.slice(0, 50),
              provider: sourceProvider,
              connectionMethod: ConnectionMethod.SYNC,
              externalFormId: account.accountId,
              // Never from the CRM: no consent basis is asserted for imported contacts.
              defaultConsentStatus: ConsentStatus.pending,
              ...sourceState,
            },
          });
        }

        // The first import, or on a reconnect a complete re-read. Never a second one: the partial unique index makes a duplicate a no-op.
        const runId = randomUUID();
        const queued = await tx.crmSyncRun.createMany({
          data: [
            {
              id: runId,
              orgId,
              leadSourceId: sourceId,
              provider: sourceProvider,
              kind: prior?.remoteSyncedAt ? CrmSyncRunKind.full : CrmSyncRunKind.initial,
              requestedBy: userId,
            },
          ],
          skipDuplicates: true,
        });

        return { leadSourceId: sourceId, runId: queued.count ? runId : null };
      },
      disconnecting: async ({ tx, orgId, row }) => {
        const sources = await tx.leadSource.findMany({
          where: { orgId, provider: sourceProvider, integrationId: row.id },
          select: { id: true },
        });
        const sourceIds = sources.map((s) => s.id);
        if (sourceIds.length) {
          await tx.leadSource.updateMany({
            where: { orgId, id: { in: sourceIds } },
            data: { isActive: false, ingestStatus: IngestStatus.PAUSED, syncNextAt: null },
          });
          await tx.crmSyncRun.updateMany({
            where: { orgId, leadSourceId: { in: sourceIds }, status: { in: [CrmSyncRunStatus.queued, CrmSyncRunStatus.running] } },
            data: {
              status: CrmSyncRunStatus.cancelled,
              finishedAt: new Date(),
              errorCode: 'DISCONNECTED',
              errorMessage: `${adapter.label.displayName} was disconnected.`,
            },
          });
          await tx.ingestEvent.updateMany({
            where: {
              orgId,
              leadSourceId: { in: sourceIds },
              provider: sourceProvider,
              queueState: { in: [QueueState.PENDING, QueueState.PROCESSING] },
            },
            data: { queueState: QueueState.DONE, outcomeReason: 'disconnected', processedAt: new Date(), lockedAt: null, lockedBy: null },
          });
        }
        return { provider: adapter.provider, leadSourceIds: sourceIds };
      },
      // The first import is queued in the transaction; wake the worker instead of waiting for its poll.
      afterConnected: async () => {
        const { CrmSyncService } = await import('./crm-sync.service');
        this.moduleRef.get(CrmSyncService, { strict: false }).nudge();
      },
      // Uninstalling stops the CRM sending webhooks for the account.
      revoke: (token) => adapter.uninstall(token),
    });
  }

  /**
   * Runs `fn` with a valid access token for this credential (see
   * ConnectionsService.withCredential). A grant that no longer works parks the
   * connection and surfaces as REAUTH, which no caller retries.
   */
  withAccessToken<T>(adapter: CrmAdapter, organizationId: string, credentialId: string, fn: (accessToken: string) => Promise<T>): Promise<T> {
    // An undefined id would match nothing; say so plainly.
    if (!credentialId) return Promise.reject(new CrmApiError('REAUTH', 'No connection', 0));
    return this.connections.withCredential(organizationId, credentialId, adapter.nangoIntegration, CRM_ERRORS, (token) => fn(token));
  }

  /** CRM failures in the API's error envelope. Never 401: the SPA reads a 401 as "your session ended". */
  toHttp(adapter: CrmAdapter, e: unknown): unknown {
    if (!(e instanceof CrmApiError)) return e;
    const name = adapter.label.displayName;
    switch (e.kind) {
      case 'REAUTH':
      case 'UNAUTHORIZED':
        return httpError(409, 'CRM_REAUTH_REQUIRED', `${name} access was revoked or has expired. Reconnect ${name} to continue.`);
      case 'RATE_LIMITED':
        return httpError(429, 'CRM_RATE_LIMITED', `${name} is rate-limiting requests. Try again in a minute.`);
      case 'UNAVAILABLE':
        return httpError(502, 'CRM_UNAVAILABLE', `${name} did not respond. Try again shortly.`);
      default:
        return httpError(502, 'CRM_REQUEST_FAILED', `${name} refused the request: ${e.message}`);
    }
  }
}
