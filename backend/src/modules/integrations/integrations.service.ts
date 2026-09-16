/**
 * Storing and using a form provider's API credential.
 *
 * Two rules shape everything here:
 *
 *  1. A credential is VERIFIED BEFORE IT IS STORED. We call the provider with
 *     it first; a key that does not work never reaches the database. The
 *     alternative — store then validate — leaves rows nobody can explain.
 *
 *  2. The plaintext key leaves this service only into an adapter call. No
 *     endpoint returns it, no log line contains it, and the summary DTO carries
 *     a prefix and last four so support can still answer "which key is this?".
 */

import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SecretBox, providerCredentialAad, sha256Hex } from '../../common/crypto';
import { CredentialStatus } from '../../common/domain';
import { newId } from '../../common/ids';
import { PrismaService } from '../../prisma/prisma.service';
import { ProviderRegistry } from '../providers/provider.registry';
import { ProviderApiError, type ProviderCredential } from '../providers/types';

export interface ProviderCredentialSummary {
  id: string;
  provider: string;
  label: string | null;
  /** e.g. "tly-a1b2…7f3d". Never the key. */
  credentialPreview: string;
  accountEmail: string | null;
  accountName: string | null;
  status: string;
  lastVerifiedAt: Date | null;
  lastErrorCode: string | null;
  createdAt: Date;
  /** Drives the "in use by N forms" warning on disconnect. */
  leadSourceCount: number;
}

@Injectable()
export class IntegrationsService {
  private readonly logger = new Logger(IntegrationsService.name);
  private readonly secretBox: SecretBox;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly registry: ProviderRegistry,
  ) {
    this.secretBox = new SecretBox(
      this.config.getOrThrow<string>('ENCRYPTION_KEYS'),
      this.config.getOrThrow<string>('ENCRYPTION_ACTIVE_KEY_ID'),
    );
  }

  async connect(organizationId: string, providerCode: string, apiKey: string, label?: string) {
    const key = (apiKey ?? '').trim();
    if (!key) throw new BadRequestException({ error: { code: 'CREDENTIAL_REQUIRED', message: 'An API key is required.' } });

    const adapter = this.registry.get(providerCode);
    const provider = adapter.provider;

    // Verify FIRST. A key that does not work never becomes a row.
    let account;
    try {
      account = await adapter.verifyCredential({ apiKey: key });
    } catch (e) {
      throw this.toHttp(e);
    }

    const hash = sha256Hex(key);

    // Re-pasting the same key is not an error — it is someone making sure.
    const existing = await this.prisma.provider_credentials.findFirst({
      where: { organization_id: organizationId, provider, credential_hash: hash, revoked_at: null },
    });
    if (existing) {
      const refreshed = await this.prisma.provider_credentials.update({
        where: { id: existing.id },
        data: {
          status: CredentialStatus.ACTIVE,
          last_verified_at: new Date(),
          last_error_at: null,
          last_error_code: null,
          account_email: account.email,
          account_name: account.displayName,
          external_account_id: account.externalAccountId,
          ...(label ? { label } : {}),
          updated_at: new Date(),
        },
      });
      return this.toSummary(refreshed, await this.countSources(refreshed.id));
    }

    // The id must exist before encrypting: the AAD binds ciphertext to the row.
    const id = newId();
    const created = await this.prisma.provider_credentials.create({
      data: {
        id,
        organization_id: organizationId,
        provider,
        label: label ?? account.email ?? adapter.displayName,
        credential_enc: this.secretBox.encrypt(key, providerCredentialAad(organizationId, id)),
        credential_hash: hash,
        credential_prefix: key.slice(0, 8),
        credential_last4: key.slice(-4),
        external_account_id: account.externalAccountId,
        account_email: account.email,
        account_name: account.displayName,
        status: CredentialStatus.ACTIVE,
        last_verified_at: new Date(),
      },
    });

    this.logger.log(`Connected ${provider} for org ${organizationId} (${created.credential_prefix}…)`);
    return this.toSummary(created, 0);
  }

  async list(organizationId: string, provider?: string) {
    const rows = await this.prisma.provider_credentials.findMany({
      where: { organization_id: organizationId, revoked_at: null, ...(provider ? { provider } : {}) },
      orderBy: { created_at: 'desc' },
    });
    return Promise.all(rows.map(async (r) => this.toSummary(r, await this.countSources(r.id))));
  }

  /** Re-checks a stored credential against the provider and records the verdict. */
  async verify(organizationId: string, id: string) {
    const row = await this.mustFind(organizationId, id);
    const adapter = this.registry.get(row.provider);

    try {
      const account = await adapter.verifyCredential({ apiKey: this.decrypt(row) });
      const ok = await this.prisma.provider_credentials.update({
        where: { id: row.id },
        data: {
          status: CredentialStatus.ACTIVE,
          last_verified_at: new Date(),
          last_error_at: null,
          last_error_code: null,
          account_email: account.email,
          account_name: account.displayName,
        },
      });
      return this.toSummary(ok, await this.countSources(row.id));
    } catch (e) {
      if (e instanceof ProviderApiError && e.kind === 'INVALID_CREDENTIAL') {
        const bad = await this.markInvalid(row.id, e.kind);
        return this.toSummary(bad, await this.countSources(row.id));
      }
      throw this.toHttp(e);
    }
  }

  /**
   * Revoke.
   *
   * Refuses while lead sources still reference it, because removing it silently
   * strips our ability to repair or remove their webhooks. `force` proceeds
   * anyway — the caller is expected to have told the user what that costs.
   *
   * Worth stating plainly in the UI: revoking does NOT stop ingestion. The
   * webhook still points at our URL and deliveries still arrive; all that is
   * lost is our ability to MANAGE it.
   */
  async revoke(organizationId: string, id: string, force = false) {
    const row = await this.mustFind(organizationId, id);
    const sources = await this.prisma.lead_sources.findMany({
      where: { organization_id: organizationId, provider_credential_id: id, archived_at: null },
      select: { id: true, name: true },
    });

    if (sources.length > 0 && !force) {
      throw new ConflictException({
        error: {
          code: 'CREDENTIAL_IN_USE',
          message: `${sources.length} lead source(s) were connected with this key. Disconnect them first, or pass force=true.`,
          leadSources: sources,
        },
      });
    }

    await this.prisma.provider_credentials.update({
      where: { id: row.id },
      data: { status: CredentialStatus.REVOKED, revoked_at: new Date() },
    });

    // Sources keep working — their webhook is still installed — but we can no
    // longer manage it, which `remote_state` must reflect honestly.
    await this.prisma.lead_sources.updateMany({
      where: { organization_id: organizationId, provider_credential_id: id },
      data: { provider_credential_id: null, remote_state: 'ORPHANED' },
    });

    return { revoked: true, orphanedLeadSources: sources.length };
  }

  /**
   * external_form_id -> lead_source id, for annotating the form picker.
   *
   * A courtesy pre-check only. The unique index on
   * (organization_id, provider, external_form_id) is what actually prevents a
   * double connect, because a check-then-insert races against a double click.
   */
  async connectedFormIds(organizationId: string): Promise<Map<string, string>> {
    const rows = await this.prisma.lead_sources.findMany({
      where: { organization_id: organizationId, archived_at: null, external_form_id: { not: null } },
      select: { id: true, external_form_id: true },
    });
    return new Map(rows.filter((r) => r.external_form_id).map((r) => [r.external_form_id!, r.id]));
  }

  /** Plaintext key for one adapter call. Callers must not retain it. */
  async credentialFor(organizationId: string, id: string): Promise<ProviderCredential & { provider: string }> {
    const row = await this.mustFind(organizationId, id);
    if (row.status === CredentialStatus.REVOKED) {
      throw new ConflictException({
        error: { code: 'CREDENTIAL_REVOKED', message: 'That connection was disconnected. Reconnect it first.' },
      });
    }
    return { apiKey: this.decrypt(row), provider: row.provider };
  }

  async markInvalid(id: string, code: string) {
    return this.prisma.provider_credentials.update({
      where: { id },
      data: { status: CredentialStatus.INVALID, last_error_at: new Date(), last_error_code: code },
    });
  }

  /** Maps a provider failure onto the HTTP shape the SPA already unwraps. */
  toHttp(e: unknown) {
    if (!(e instanceof ProviderApiError)) return e;

    const body = { error: { code: `PROVIDER_${e.kind}`, message: e.message } };
    switch (e.kind) {
      case 'INVALID_CREDENTIAL':
      case 'INVALID_REQUEST':
        return new BadRequestException(body);
      case 'NOT_FOUND':
        return new NotFoundException(body);
      case 'FORBIDDEN':
        return new ConflictException(body);
      default:
        // 429 and 5xx: the caller should retry, and nothing was created.
        return new ConflictException(body);
    }
  }

  private async mustFind(organizationId: string, id: string) {
    const row = await this.prisma.provider_credentials.findFirst({
      where: { id, organization_id: organizationId },
    });
    if (!row) throw new NotFoundException({ error: { code: 'CREDENTIAL_NOT_FOUND', message: 'No such connection.' } });
    return row;
  }

  private decrypt(row: { id: string; organization_id: string; credential_enc: string }): string {
    return this.secretBox.decrypt(row.credential_enc, providerCredentialAad(row.organization_id, row.id));
  }

  private countSources(credentialId: string) {
    return this.prisma.lead_sources.count({ where: { provider_credential_id: credentialId, archived_at: null } });
  }

  private toSummary(
    row: {
      id: string;
      provider: string;
      label: string | null;
      credential_prefix: string;
      credential_last4: string;
      account_email: string | null;
      account_name: string | null;
      status: string;
      last_verified_at: Date | null;
      last_error_code: string | null;
      created_at: Date;
    },
    leadSourceCount: number,
  ): ProviderCredentialSummary {
    return {
      id: row.id,
      provider: row.provider,
      label: row.label,
      credentialPreview: `${row.credential_prefix}…${row.credential_last4}`,
      accountEmail: row.account_email,
      accountName: row.account_name,
      status: row.status,
      lastVerifiedAt: row.last_verified_at,
      lastErrorCode: row.last_error_code,
      createdAt: row.created_at,
      leadSourceCount,
    };
  }
}
