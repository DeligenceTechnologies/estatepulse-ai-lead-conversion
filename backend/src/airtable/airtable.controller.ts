import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AirtableEnabledGuard } from '@/google-sheets/import-enabled.guard';
import { NangoService } from '@/nango/nango.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AirtableClient } from './airtable.client';
import { AirtableConnectionsService, type SessionIdentity } from './airtable-connections.service';
import { AirtableSourcesService } from './airtable-sources.service';
import {
  CreateAirtableFieldDto,
  CreateAirtableSourceDto,
  ImportAirtableDto,
  SaveAirtableMappingDto,
  SetAirtableSyncDto,
} from './dto/airtable.dto';

const identity = (auth: AuthContext): SessionIdentity => ({
  organizationId: auth.organizationId,
  userId: auth.userId,
  sessionId: auth.sessionId,
});

/**
 * Connecting an Airtable account: `/integrations/airtable/...`.
 *
 * The organization, user and session are never parameters: they come from the
 * authenticated session. The consent screen runs in Nango Connect; the browser
 * reports the connection id Nango assigned, and the server checks with Nango
 * that it was created for this organization before linking it.
 *
 * Switched off (AIRTABLE_ENABLED unset), every route answers 404, so the UI
 * hides the card and nothing about the integration leaks.
 */
@Controller('integrations/airtable')
@UseGuards(AirtableEnabledGuard)
export class AirtableController {
  constructor(
    private readonly connections: AirtableConnectionsService,
    private readonly sources: AirtableSourcesService,
    private readonly client: AirtableClient,
    private readonly nango: NangoService,
  ) {}

  /** Whether this server can run the flow at all, and which permissions it will ask for. */
  @Get('config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  config() {
    return {
      provider: 'airtable',
      displayName: 'Airtable',
      configured: this.nango.configured,
      requestedScopes: this.client.requestedScopes,
    };
  }

  /** The organization's connected Airtable accounts. Never a token. */
  @Get('connections')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    return { connections: await this.connections.list(auth.organizationId) };
  }

  // Connecting and disconnecting Airtable: /connections/airtable/* (ConnectionsController).

  // ---------------------------------------------------------------------------
  // Bases, tables and the sources built from them
  // ---------------------------------------------------------------------------

  /** The bases this connection can see. Read live: the owner may change what it may touch. */
  @Get('connections/:id/bases')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  bases(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.sources.bases(auth.organizationId, id);
  }

  /** A base's tables, with each table's fields and their Airtable types. */
  @Get('connections/:id/bases/:baseId/tables')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  tables(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Param('baseId') baseId: string) {
    return this.sources.tables(auth.organizationId, id, baseId);
  }

  @Get('sources')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async listSources(@CurrentAuth() auth: AuthContext) {
    return { sources: await this.sources.list(auth.organizationId) };
  }

  /** Start syncing one table. */
  @Post('sources')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  createSource(@CurrentAuth() auth: AuthContext, @Body() body: CreateAirtableSourceDto) {
    return this.sources.create(identity(auth), body);
  }

  /** The table's fields, the saved mapping, and what importing would do — writing nothing. */
  @Get('sources/:sourceId/preview')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  preview(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.preview(auth.organizationId, sourceId);
  }

  @Put('sources/:sourceId/mapping')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  saveMapping(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string, @Body() body: SaveAirtableMappingDto) {
    return this.sources.saveMapping(identity(auth), sourceId, body);
  }

  /** Import the table's records. Ticked records are approved; the rest wait in Import Review. */
  @Post('sources/:sourceId/import')
  @RequirePermissions(PERMISSIONS.LEAD_IMPORT)
  startImport(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string, @Body() body: ImportAirtableDto) {
    return this.sources.startImport(identity(auth), sourceId, body);
  }

  /** Which way this table syncs, and how conflicts are settled. */
  @Put('sources/:sourceId/sync-config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  setSyncConfig(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string, @Body() body: SetAirtableSyncDto) {
    return this.sources.setSyncConfig(identity(auth), sourceId, body);
  }

  /** Everything the sync dashboard shows. */
  @Get('sources/:sourceId/status')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  status(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.status(auth.organizationId, sourceId);
  }

  /** Run a sync now rather than waiting for the next scheduled one. */
  @Post('sources/:sourceId/sync')
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  syncNow(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.syncNow(identity(auth), sourceId);
  }

  /** Put failed writes back in the queue. */
  @Post('sources/:sourceId/retry')
  @HttpCode(202)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  retryFailed(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.retryFailed(identity(auth), sourceId);
  }

  /** What EstatePulse can report back about a lead, for the owner to choose from. */
  @Get('write-back-fields')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  writeBackFields() {
    return this.sources.writeBackFields();
  }

  /** This table's columns on their own, for choosing where a report lands. */
  @Get('sources/:sourceId/fields')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  tableFields(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.tableFields(auth.organizationId, sourceId);
  }

  /** The Airtable field types an owner may create. */
  @Get('field-types')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  fieldTypes() {
    return this.sources.fieldTypes();
  }

  /**
   * Add a column to the Airtable table. Needs schema.bases:write, which record
   * write does not imply; without it this answers 403 and record sync is
   * unaffected.
   */
  @Post('sources/:sourceId/fields')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  createField(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string, @Body() body: CreateAirtableFieldDto) {
    return this.sources.createField(identity(auth), sourceId, body);
  }

  /** Stop syncing this table. Imported leads and their review rows are kept. */
  @Delete('sources/:sourceId')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  removeSource(@CurrentAuth() auth: AuthContext, @Param('sourceId', ParseUUIDPipe) sourceId: string) {
    return this.sources.remove(identity(auth), sourceId);
  }
}
