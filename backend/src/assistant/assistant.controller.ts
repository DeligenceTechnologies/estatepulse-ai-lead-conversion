import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Put, Query, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AssistantActionService } from './assistant-action.service';
import { AssistantActivityService } from './assistant-activity.service';
import { ConfirmActionDto } from './dto/confirm-action.dto';
import { RateAnswerDto } from './dto/rate-answer.dto';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { AssistantSettingsService } from './assistant-settings.service';
import { AssistantConfig } from './assistant.config';
import { ToolRegistry } from './tools/tool-registry.service';
import { UpdateAssistantSettingsDto } from './dto/update-assistant-settings.dto';
import { AssistantUsageService } from './assistant-usage.service';
import { RequirePermissions } from '@/role/decorators/require-permissions.decorator';
import { PERMISSIONS } from '@/role/permissions';
import { AssistantThreadService } from './assistant-thread.service';
import { AssistantService } from './assistant.service';
import { SendMessageDto } from './dto/send-message.dto';
import { EventStream } from './event-stream';

/**
 * Ask EstatePulse, the in-app assistant, for users whose role has assistant.use. Each tool also checks
 * the same permissions as the screen it stands in for. A route's own @RequirePermissions replaces the
 * class one: the settings routes are for owners, and status answers everyone so the app knows to hide it.
 * Streaming routes answer text/event-stream; a check that fails before the stream opens answers as JSON.
 */
@Controller('v1/assistant')
@RequirePermissions(PERMISSIONS.ASSISTANT_USE)
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadService,
    private readonly orchestrator: AssistantOrchestrator,
    private readonly activity: AssistantActivityService,
    private readonly settings: AssistantSettingsService,
    private readonly usage: AssistantUsageService,
    private readonly config: AssistantConfig,
    private readonly registry: ToolRegistry,
    private readonly actions: AssistantActionService,
  ) {}

  /** Settings > Ask EstatePulse: the office's switch, monthly limit and microphone, with this month's spend. */
  @Get('settings')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  async getSettings(@CurrentAuth() auth: AuthContext) {
    const [settings, usage, rolesWithAccess] = await Promise.all([
      this.settings.get(auth.organizationId),
      this.usage.summary(auth.organizationId),
      this.settings.rolesWithAccess(auth.organizationId),
    ]);
    return { settings, usage, rolesWithAccess, serverEnabled: this.config.enabled, canEdit: this.settings.canEdit(auth) };
  }

  @Put('settings')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_UPDATE)
  async updateSettings(@CurrentAuth() auth: AuthContext, @Body() body: UpdateAssistantSettingsDto) {
    const settings = await this.settings.update(auth, body);
    const [usage, rolesWithAccess] = await Promise.all([this.usage.summary(auth.organizationId), this.settings.rolesWithAccess(auth.organizationId)]);
    return { settings, usage, rolesWithAccess, serverEnabled: this.config.enabled, canEdit: true };
  }

  /** Everything the assistant did in the office, for owners to review. */
  @Get('log')
  @RequirePermissions(PERMISSIONS.ORGANIZATION_READ)
  log(@CurrentAuth() auth: AuthContext, @Query('before') before?: string) {
    const cursor = before ? new Date(before) : undefined;
    return this.settings.log(auth, (tool) => this.registry.label(tool), cursor && !Number.isNaN(cursor.getTime()) ? cursor : undefined);
  }

  /** Open to every signed-in user (an empty list replaces the class's assistant.use). */
  @Get('status')
  @RequirePermissions()
  status(@CurrentAuth() auth: AuthContext) {
    return this.assistant.status(auth);
  }

  /** The Activity panel: cards waiting on this user, broken connections, and the office's last 24 hours. */
  @Get('activity')
  feed(@CurrentAuth() auth: AuthContext, @Query('before') before?: string) {
    const cursor = before ? new Date(before) : undefined;
    return this.activity.feed(auth, { before: cursor && !Number.isNaN(cursor.getTime()) ? cursor : undefined });
  }

  @Get('threads')
  list(@CurrentAuth() auth: AuthContext) {
    return this.threads.list(auth);
  }

  @Get('threads/:id')
  thread(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.threads.view(auth, id);
  }

  @Delete('threads/:id')
  @HttpCode(HttpStatus.NO_CONTENT)
  async remove(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.threads.remove(auth, id);
  }

  /** Stops the answer being written in this chat. The browser closing does not stop it; this does. */
  @Post('threads/:id/stop')
  @HttpCode(HttpStatus.NO_CONTENT)
  async stop(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string): Promise<void> {
    await this.assistant.stop(auth, id);
  }

  @Post('messages')
  send(@CurrentAuth() auth: AuthContext, @Body() body: SendMessageDto, @Res() res: Response): Promise<void> {
    return this.stream(res, (stream) => this.assistant.send(auth, body, stream));
  }

  /** A thumbs up or down on one answer in the person's own chat. */
  @Put('messages/:id/feedback')
  async rate(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: RateAnswerDto) {
    return { feedback: await this.threads.rate(auth, id, body) };
  }

  /** For a bulk card above 10 leads, the body carries the count the user typed. */
  @Post('actions/:id/confirm')
  confirm(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Body() body: ConfirmActionDto, @Res() res: Response): Promise<void> {
    return this.stream(res, (stream) => this.assistant.decide(auth, id, 'confirm', stream, body?.count));
  }

  /** A bulk card's job: how far it got, and the first leads that failed or were skipped. */
  @Get('actions/:id/progress')
  progress(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.bulkProgress(auth, id);
  }

  @Post('actions/:id/stop')
  @HttpCode(HttpStatus.OK)
  stopBulk(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.actions.stopBulk(auth, id);
  }

  @Post('actions/:id/reject')
  reject(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    return this.stream(res, (stream) => this.assistant.decide(auth, id, 'reject', stream));
  }

  /** Errors raised before the first event go to Nest's error handling; after it, they become an error event. */
  private async stream(res: Response, work: (stream: EventStream) => Promise<void>): Promise<void> {
    const stream = new EventStream(res);
    try {
      await work(stream);
    } catch (error) {
      if (!stream.isOpen) throw error;
      stream.send({ type: 'error', ...this.orchestrator.describe(error) });
      stream.send({ type: 'done', awaitingConfirmation: false });
    }
    stream.end();
  }
}
