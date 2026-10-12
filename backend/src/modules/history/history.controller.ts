import { Controller, Get, Param, ParseUUIDPipe, Query, Req, UseGuards } from '@nestjs/common';
import { SessionGuard, type SessionRequest } from '../../common/guards/session.guard';
import { HistoryService } from './history.service';

/**
 * Call and message history.
 *
 * SessionGuard rather than TenantGuard, deliberately: what an agent may see is
 * narrower than what the organization may see, and TenantGuard resolves only a
 * tenant — it also accepts a machine API key, which has no role at all. Every
 * route here is about a *user* looking at their office.
 */
@Controller('api/v1')
@UseGuards(SessionGuard)
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('calls')
  listCalls(
    @Req() req: SessionRequest,
    @Query('limit') limit?: string,
    @Query('agentId') agentId?: string,
    @Query('outcome') outcome?: string,
    @Query('temperature') temperature?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('q') q?: string,
    // One lead's calls (the lead detail view). Combined with the session's org
    // and, for an agent, their visibility rules — never a way around either.
    @Query('leadId', new ParseUUIDPipe({ optional: true })) leadId?: string,
  ) {
    return this.history.listCalls(req.auth, { limit, agentId, outcome, temperature, from, to, q, leadId });
  }

  @Get('calls/:id')
  getCall(@Req() req: SessionRequest, @Param('id') id: string) {
    return this.history.getCall(req.auth, id);
  }

  @Get('conversations')
  listConversations(
    @Req() req: SessionRequest,
    @Query('limit') limit?: string,
    @Query('leadId', new ParseUUIDPipe({ optional: true })) leadId?: string,
  ) {
    return this.history.listConversations(req.auth, limit, leadId);
  }

  @Get('conversations/:id/messages')
  listMessages(@Req() req: SessionRequest, @Param('id') id: string) {
    return this.history.listMessages(req.auth, id);
  }

  /**
   * One lead's SMS messages across all its threads (the lead detail view), in
   * one request rather than the thread list and then one request per thread.
   * leadId is required: this reads a lead's history, never a whole mailbox.
   */
  @Get('messages')
  listLeadMessages(@Req() req: SessionRequest, @Query('leadId', ParseUUIDPipe) leadId: string) {
    return this.history.listLeadMessages(req.auth, leadId);
  }
}
