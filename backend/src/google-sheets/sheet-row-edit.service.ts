import { Injectable, Logger } from '@nestjs/common';
import { ConnectionMethod, LeadSourceProvider, ReviewState } from '@prisma/client';
import { createHash } from 'node:crypto';
import { AuditService } from '@/audit/audit.service';
import { AppError } from '@/common/errors/app-error';
import { PrismaService } from '@/common/prisma/prisma.service';
import { CONTACT_EDIT_TARGETS, validatedContactEdit, type ContactEditTarget } from '@/lead/contact-edit';
import { GoogleConnectionsService, type SessionIdentity } from './google-connections.service';
import { GoogleApiError, GoogleClient } from './google.client';
import type { EditSheetRowDto } from './dto/sheets.dto';
import { SheetImportService } from './sheet-import.service';
import { MAX_COLUMNS, analyzeHeaders } from './sheet-rows';

/** What Import Review may change on a sheet row, by the lead field each one fills. */
export const EDITABLE_TARGETS = CONTACT_EDIT_TARGETS;
export type EditableTarget = ContactEditTarget;

/** The edit fields a source's mapping has a column for. */
export function editableTargets(mappings: { targetField: string }[]): EditableTarget[] {
  const mapped = new Set(mappings.map((m) => m.targetField));
  return EDITABLE_TARGETS.filter((t) => mapped.has(t));
}

/** Whether a sheet row can be edited from Import Review: pending, still in the sheet, and found by an ID column that edits cannot change. */
export function rowIsEditable(row: {
  reviewState: ReviewState;
  missingSince: Date | null;
  leadId: string | null;
  leadSource: { provider: LeadSourceProvider; connectionMethod: ConnectionMethod; syncRowKeyField: string | null };
}): boolean {
  return (
    row.reviewState === ReviewState.pending &&
    !row.missingSince &&
    !!row.leadId &&
    row.leadSource.provider === LeadSourceProvider.GOOGLE_SHEETS &&
    row.leadSource.connectionMethod === ConnectionMethod.SYNC &&
    !!row.leadSource.syncRowKeyField
  );
}

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/**
 * Corrects a lead still waiting in Import Review by correcting its row in the Google Sheet, then
 * re-reading the sheet: the import engine refreshes the pending lead from the row (normalising the
 * phone and email, and recomputing do-not-contact, duplicate and warning reasons), so the lead and
 * the sheet always say the same thing and the next scheduled sync sees nothing new.
 *
 * Only for sheets synced by an ID column: there a row is found by its ID cell, which an edit never
 * touches. Without one a row is known by its name, phone and email, and editing those would make
 * it a different row (and a second lead).
 */
@Injectable()
export class SheetRowEditService {
  private readonly logger = new Logger(SheetRowEditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connections: GoogleConnectionsService,
    private readonly google: GoogleClient,
    private readonly importer: SheetImportService,
    private readonly audit: AuditService,
  ) {}

  async edit(who: SessionIdentity, rowId: string, input: EditSheetRowDto): Promise<{ written: EditableTarget[]; synced: boolean }> {
    const orgId = who.organizationId;
    const row = await this.prisma.sheetImportRow.findFirst({
      where: { id: rowId, orgId },
      select: {
        id: true,
        rowKey: true,
        rowNumber: true,
        reviewState: true,
        missingSince: true,
        leadId: true,
        leadSourceId: true,
        lead: { select: { firstName: true, lastName: true, phone: true, email: true } },
        leadSource: { select: { provider: true, connectionMethod: true, integrationId: true, externalFormId: true, syncRowKeyField: true } },
      },
    });
    if (!row) throw new AppError('NOT_FOUND', 'That row is no longer in Import Review.');
    if (!rowIsEditable(row) || !row.lead) {
      throw new AppError('CONFLICT', 'Only a Google Sheets row still waiting for review, in a sheet synced by an ID column, can be edited here.');
    }

    const [spreadsheetId, sheetIdText] = (row.leadSource.externalFormId ?? '').split(':');
    const sheetId = Number(sheetIdText);
    if (!row.leadSource.integrationId || !spreadsheetId || !Number.isInteger(sheetId)) {
      throw new AppError('CONFLICT', 'This sheet has no Google connection. Reconnect it first.');
    }

    const mappings = await this.prisma.leadSourceFieldMapping.findMany({
      where: { orgId, leadSourceId: row.leadSourceId, isActive: true },
      select: { sourceFieldKey: true, targetField: true, transform: true },
    });
    const changes = validatedContactEdit(input, row.lead);
    if (changes.size === 0) return { written: [], synced: false };
    const unmapped = [...changes.keys()].filter((t) => !mappings.some((m) => m.targetField === t));
    if (unmapped.length) {
      throw new AppError('VALIDATION_ERROR', `The sheet has no column for ${unmapped.join(', ').replace(/_/g, ' ')}, so it cannot be changed here.`);
    }

    const idKey = row.leadSource.syncRowKeyField!;
    const written = await this.connections.withAccessToken(orgId, row.leadSource.integrationId, async (token) => {
      const [headerCells = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, MAX_COLUMNS, 0);
      const headers = analyzeHeaders(headerCells);
      const column = (fieldKey: string): number => {
        const h = headers.find((x) => x.fieldKey === fieldKey);
        if (!h || h.duplicate) throw new AppError('CONFLICT', 'The sheet’s header row changed since the last sync. Sync and try again.');
        return h.index;
      };
      const idCol = column(idKey);

      // The row is where the last sync saw it, unless someone sorted or inserted rows since: its ID cell says.
      const rowIndex = row.rowNumber - 1;
      const [cells = []] = await this.google.readGrid(token, spreadsheetId, sheetId, 1, MAX_COLUMNS, rowIndex);
      const id = (cells[idCol] ?? '').trim();
      if (!id || sha256(`id\u0000${id}`) !== row.rowKey) {
        void this.importer.syncSourceNow(orgId, row.leadSourceId).catch(() => undefined);
        throw new AppError('CONFLICT', 'The sheet changed since the last sync, so this row moved. It is syncing now; try again in a moment.');
      }

      const out = new Map<number, string>();
      for (const m of mappings) {
        const target = m.targetField as EditableTarget;
        if (!changes.has(target)) continue;
        const col = column(m.sourceFieldKey);
        if ((m.transform as { kind?: string } | null)?.kind === 'name_split') {
          // One "Full name" column feeds both names: it is written whole, from both.
          const first = changes.get('first_name') ?? row.lead!.firstName ?? '';
          const last = changes.get('last_name') ?? row.lead!.lastName ?? '';
          out.set(col, `${first} ${last}`.trim());
        } else {
          out.set(col, changes.get(target)!);
        }
      }
      const toWrite = [...out].filter(([col, value]) => (cells[col] ?? '').trim() !== value).map(([col, value]) => ({ row: rowIndex, col, value }));
      try {
        await this.google.writeCells(token, spreadsheetId, sheetId, toWrite);
      } catch (error) {
        if (error instanceof GoogleApiError && error.kind === 'DENIED') {
          throw new AppError('FORBIDDEN', 'The connected Google account can’t edit this sheet. Give it edit access, or fix the row in the sheet.');
        }
        throw error;
      }
      return toWrite.length;
    });

    const fields = [...changes.keys()];
    await this.audit.record({
      orgId,
      actorType: 'user',
      actorId: who.userId,
      action: 'sheet.row_edited',
      entityType: 'lead',
      entityId: row.leadId,
      payload: { leadSourceId: row.leadSourceId, rowNumber: row.rowNumber, fields, cellsWritten: written },
    });

    const { ran } = await this.importer.syncSourceNow(orgId, row.leadSourceId).catch((error) => {
      this.logger.warn(`sheet ${row.leadSourceId}: re-read after an edit failed: ${(error as Error).message}`);
      return { ran: false };
    });
    return { written: fields, synced: ran };
  }
}
