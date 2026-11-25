import { Body, Controller, Delete, Get, HttpCode, HttpStatus, Param, ParseUUIDPipe, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { AssistantOrchestrator } from './assistant-orchestrator.service';
import { AssistantThreadService } from './assistant-thread.service';
import { AssistantService } from './assistant.service';
import { SendMessageDto } from './dto/send-message.dto';
import { EventStream } from './event-stream';

/**
 * Ask EstatePulse, the in-app assistant. Open to every signed-in user: each tool checks the same permissions as the screen it stands in for.
 * Streaming routes answer text/event-stream; a check that fails before the stream opens answers as JSON.
 */
@Controller('v1/assistant')
export class AssistantController {
  constructor(
    private readonly assistant: AssistantService,
    private readonly threads: AssistantThreadService,
    private readonly orchestrator: AssistantOrchestrator,
  ) {}

  @Get('status')
  status(@CurrentAuth() auth: AuthContext) {
    return this.assistant.status(auth);
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

  @Post('actions/:id/confirm')
  confirm(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string, @Res() res: Response): Promise<void> {
    return this.stream(res, (stream) => this.assistant.decide(auth, id, 'confirm', stream));
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
