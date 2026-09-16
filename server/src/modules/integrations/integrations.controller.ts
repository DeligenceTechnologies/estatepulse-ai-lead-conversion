import {
  Body,
  Controller,
  Delete,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import { ApiKeyGuard, type AuthedRequest } from '../../common/api-key.guard';
import { ProviderRegistry } from '../providers/provider.registry';
import { IntegrationsService } from './integrations.service';

/**
 * Connecting a form provider account.
 *
 * `POST /` is the only endpoint in the system that accepts a third-party
 * credential, and it is the only place the plaintext exists in a request. No
 * response here ever contains it — see ProviderCredentialSummary.
 */
@Controller('v1/integrations')
@UseGuards(ApiKeyGuard)
export class IntegrationsController {
  constructor(
    private readonly service: IntegrationsService,
    private readonly registry: ProviderRegistry,
  ) {}

  /**
   * What the UI needs to render a connect form without shipping any
   * provider-specific copy of its own.
   */
  @Get('providers')
  providers() {
    return this.registry.list();
  }

  @Post()
  connect(
    @Req() req: AuthedRequest,
    @Body() body: { provider?: string; apiKey?: string; label?: string },
  ) {
    return this.service.connect(
      req.tenant.organizationId,
      body?.provider ?? 'TALLY',
      body?.apiKey ?? '',
      body?.label,
    );
  }

  @Get()
  list(@Req() req: AuthedRequest, @Query('provider') provider?: string) {
    return this.service.list(req.tenant.organizationId, provider);
  }

  @Post(':id/verify')
  verify(@Req() req: AuthedRequest, @Param('id', ParseUUIDPipe) id: string) {
    return this.service.verify(req.tenant.organizationId, id);
  }

  @Delete(':id')
  revoke(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('force') force?: string,
  ) {
    return this.service.revoke(req.tenant.organizationId, id, force === 'true');
  }

  /**
   * The connected account's forms, annotated with whether we already have a
   * lead source for each. That is a courtesy pre-check for the picker — the
   * unique index on (organization_id, provider, external_form_id) is what
   * actually prevents a double connect.
   */
  @Get(':id/forms')
  async forms(
    @Req() req: AuthedRequest,
    @Param('id', ParseUUIDPipe) id: string,
    @Query('cursor') cursor?: string,
  ) {
    const org = req.tenant.organizationId;
    const cred = await this.service.credentialFor(org, id);
    const adapter = this.registry.get(cred.provider);

    let page;
    try {
      page = await adapter.listForms({ apiKey: cred.apiKey }, cursor ?? null);
    } catch (e) {
      if (e instanceof Error && e.name === 'ProviderApiError') {
        // A key that has since been revoked in Tally should stop looking ACTIVE.
        if ((e as { kind?: string }).kind === 'INVALID_CREDENTIAL') {
          await this.service.markInvalid(id, 'INVALID_CREDENTIAL');
        }
      }
      throw this.service.toHttp(e);
    }

    const connected = await this.service.connectedFormIds(org);

    return {
      items: page.items.map((f) => ({
        externalFormId: f.externalFormId,
        name: f.name,
        status: f.status,
        submissionCount: f.submissionCount,
        isClosed: f.isClosed,
        updatedAt: f.updatedAt,
        connectedLeadSourceId: connected.get(f.externalFormId) ?? null,
      })),
      nextCursor: page.nextCursor,
    };
  }

}
