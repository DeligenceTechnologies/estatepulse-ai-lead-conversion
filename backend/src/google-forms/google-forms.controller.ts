import { Body, Controller, Delete, Get, HttpCode, Param, ParseUUIDPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import type { SessionIdentity } from '@/google-sheets/google-connections.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { CreateFormSourceDto, SaveFormMappingDto } from './dto/google-forms.dto';
import { FormsPollService } from './forms-poll.service';
import { GoogleFormsEnabledGuard } from './google-forms-enabled.guard';
import { GoogleFormsService } from './google-forms.service';

const identity = (auth: AuthContext): SessionIdentity => ({
  organizationId: auth.organizationId,
  userId: auth.userId,
  sessionId: auth.sessionId,
});

/**
 * Managing Google Forms sources.
 *
 * Connecting the Google ACCOUNT is not here: that is one account per
 * organization, shared with Google Sheets, and it stays on
 * /integrations/google-sheets/oauth/*. A second OAuth flow for the same
 * account is exactly what this integration must not grow.
 *
 * Every route is scoped to the caller's organization by the service, which
 * resolves each source by (id, orgId): one organization cannot name another's
 * form, whatever id it sends.
 */
@Controller('integrations/google-forms')
@UseGuards(GoogleFormsEnabledGuard)
export class GoogleFormsController {
  constructor(
    private readonly forms: GoogleFormsService,
    private readonly poll: FormsPollService,
  ) {}

  /** The OAuth client and picker keys — the same ones Google Sheets reports. */
  @Get('config')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  config() {
    return this.forms.publicConfig();
  }

  @Get('sources')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  async list(@CurrentAuth() auth: AuthContext) {
    return { sources: await this.forms.list(auth.organizationId) };
  }

  @Post('sources')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  create(@CurrentAuth() auth: AuthContext, @Body() body: CreateFormSourceDto) {
    return this.forms.create(identity(auth), body);
  }

  /** The form's questions and what each is mapped to. `?refresh=1` re-reads Google. */
  @Get('sources/:id/questions')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  questions(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Query('refresh') refresh?: string) {
    return this.forms.questions(auth.organizationId, id, refresh === '1' || refresh === 'true');
  }

  @Put('sources/:id/mapping')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  saveMapping(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: SaveFormMappingDto) {
    return this.forms.saveMapping(identity(auth), id, body);
  }

  /** The generated Apps Script, with this source's own URL and signing key. */
  @Get('sources/:id/script')
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  script(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.appsScript(auth.organizationId, id);
  }

  @Post('sources/:id/activate')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  activate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.activate(identity(auth), id);
  }

  @Post('sources/:id/pause')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  pause(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.pause(identity(auth), id);
  }

  @Delete('sources/:id')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.remove(identity(auth), id);
  }

  @Get('sources/:id/test')
  @RequirePermissions(PERMISSIONS.INTEGRATION_READ)
  test(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.forms.test(auth.organizationId, id);
  }

  /** Runs the recovery poll now instead of waiting for its turn. */
  @Post('sources/:id/check')
  @HttpCode(200)
  @RequirePermissions(PERMISSIONS.INTEGRATION_UPDATE)
  async check(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    await this.forms.mustFind(auth.organizationId, id);
    const ran = await this.poll.runNow(auth.organizationId, id);
    return { checked: ran };
  }
}
