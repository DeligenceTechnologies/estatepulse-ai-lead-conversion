import { Injectable } from '@nestjs/common';
import { QueueState, SignatureState } from '@prisma/client';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { sha256Hex } from '@/common/utils/crypto';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { validatedContactEdit, type ContactEditInput, type ContactEditTarget } from '@/lead/contact-edit';
import { CrmConnectionsService } from './crm-connections.service';
import { crmRowIsEditable } from './crm-records';
import { CrmSyncService } from './crm-sync.service';
import { CrmApiError, type CrmAdapter, type CrmContactUpdate } from './types';

/**
 * Corrects a lead still waiting in Import Review by correcting its contact in the CRM, then asking
 * the sync to re-read that contact, exactly as a CRM webhook would. The sync worker, under its own
 * lease, refreshes the pending lead from what the CRM now holds (normalising, and recomputing
 * do-not-contact, duplicate and warning reasons), so the lead and the CRM always agree and the next
 * reconcile finds nothing new. Nothing here writes the lead itself.
 */
@Injectable()
export class CrmRowEditService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: CrmConnectionsService,
    private readonly sync: CrmSyncService,
    private readonly audit: AuditService,
  ) {}

  async edit(who: SessionIdentity, adapter: CrmAdapter, rowId: string, input: ContactEditInput): Promise<{ written: ContactEditTarget[]; queued: boolean }> {
    const orgId = who.organizationId;
    const name = adapter.label.displayName;

    const row = await this.prisma.sheetImportRow.findFirst({
      where: { id: rowId, orgId },
      select: {
        id: true,
        rowKey: true,
        reviewState: true,
        missingSince: true,
        leadId: true,
        leadSourceId: true,
        lead: { select: { externalLeadId: true, phone: true, email: true } },
        leadSource: { select: { provider: true, connectionMethod: true, integrationId: true } },
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'That row is no longer in Import Review.');
    if (row.leadSource.provider !== adapter.provider || !crmRowIsEditable(row) || !row.lead || !row.leadSource.integrationId) {
      throw new AppError('CONFLICT', `Only a ${name} contact still waiting for review can be edited here.`);
    }
    const contactId = row.lead.externalLeadId!;

    const changes = validatedContactEdit(input, row.lead);
    if (changes.has('timezone')) throw new AppError('VALIDATION_ERROR', `The time zone is kept in EstatePulse, not written to ${name}.`);
    if (changes.size === 0) return { written: [], queued: false };
    const update: CrmContactUpdate = {
      ...(changes.has('first_name') ? { firstName: changes.get('first_name') } : {}),
      ...(changes.has('last_name') ? { lastName: changes.get('last_name') } : {}),
      ...(changes.has('phone') ? { phone: changes.get('phone') } : {}),
      ...(changes.has('email') ? { email: changes.get('email') } : {}),
    };

    await this.connections.withAccessToken(adapter, orgId, row.leadSource.integrationId, async (token) => {
      try {
        return await adapter.updateContact(token, contactId, update);
      } catch (error) {
        // Translated here, before withAccessToken sees it: a refused write must not park a
        // connection that still reads fine (a missing write scope comes back as REAUTH).
        if (error instanceof CrmApiError) {
          if (error.status === 403) throw new AppError('FORBIDDEN', `Reconnect ${name} to allow edits from EstatePulse.`);
          if (error.kind === 'CONFLICT') throw new AppError('CONFLICT', `Another ${name} contact already has this email.`);
          if (error.kind === 'NOT_FOUND') throw new AppError('NOT_FOUND', `This contact is no longer in ${name}.`);
          if (error.kind === 'BAD_REQUEST') throw new AppError('VALIDATION_ERROR', `${name} refused the change: ${error.message}`);
        }
        throw error;
      }
    });

    // The same delivery a webhook makes for a changed contact: the worker re-reads it and the lead follows.
    const payload = { contactIds: [contactId], source: 'estatepulse_edit' };
    await this.prisma.ingestEvent.create({
      data: {
        orgId,
        leadSourceId: row.leadSourceId,
        provider: row.leadSource.provider,
        eventType: 'estatepulse.contact_edited',
        dedupeKey: `edit:${row.id}:${Date.now()}`,
        payload,
        payloadHash: sha256Hex(JSON.stringify(payload)),
        signatureState: SignatureState.VALID,
        queueState: QueueState.PENDING,
      },
    });
    this.sync.nudge();

    const written = [...changes.keys()];
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId: who.userId,
      action: 'crm.contact_edited',
      entityType: 'lead',
      entityId: row.leadId,
      payload: { provider: adapter.provider, leadSourceId: row.leadSourceId, fields: written },
    });
    return { written, queued: true };
  }
}
