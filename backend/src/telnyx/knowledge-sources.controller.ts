import { Body, Controller, Delete, Get, HttpCode, Post, Query, UploadedFile, UseInterceptors } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { KnowledgeSourceNameDto, KnowledgeWebsiteDto } from './dto/telnyx.dto';
import { KnowledgeSourcesService, MAX_FILE_BYTES, type UploadedSourceFile } from './knowledge-sources.service';

/**
 * The documents and websites the AI looks answers up in. The organization comes
 * from the caller's credential; its knowledge base is found from its own
 * assistant, never from anything in the request.
 */
@Controller('knowledge/sources')
export class KnowledgeSourcesController {
  constructor(private readonly sources: KnowledgeSourcesService) {}

  @Get()
  @RequirePermissions(PERMISSIONS.AUTOMATION_READ)
  status(@CurrentAuth() auth: AuthContext) {
    return this.sources.status(auth.organizationId);
  }

  @Post('website')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  addWebsite(@CurrentAuth() auth: AuthContext, @Body() body: KnowledgeWebsiteDto) {
    return this.sources.addWebsite(auth.organizationId, body.url);
  }

  @Post('file')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: MAX_FILE_BYTES, files: 1, fields: 0 } }))
  addFile(@CurrentAuth() auth: AuthContext, @UploadedFile() file: UploadedSourceFile | undefined) {
    return this.sources.addFile(auth.organizationId, file);
  }

  @Delete()
  @RequirePermissions(PERMISSIONS.AUTOMATION_UPDATE)
  remove(@CurrentAuth() auth: AuthContext, @Query() query: KnowledgeSourceNameDto) {
    return this.sources.remove(auth.organizationId, query.name);
  }
}
