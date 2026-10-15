import { Controller, Get, Param, ParseUUIDPipe, Query } from '@nestjs/common';
import type { AuthContext } from '@/auth/auth.types';
import { CurrentAuth } from '@/auth/decorators/current-auth.decorator';
import { CallFiltersQuery, ConversationsQuery, LeadMessagesQuery } from './dto/history.query';
import { HistoryService } from './history.service';

/** Open to every signed-in user; the service limits what each one sees. */
@Controller('v1')
export class HistoryController {
  constructor(private readonly history: HistoryService) {}

  @Get('calls')
  listCalls(@CurrentAuth() auth: AuthContext, @Query() query: CallFiltersQuery) {
    return this.history.listCalls(auth, query);
  }

  @Get('calls/:id')
  getCall(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.history.getCall(auth, id);
  }

  @Get('conversations')
  listConversations(@CurrentAuth() auth: AuthContext, @Query() query: ConversationsQuery) {
    return this.history.listConversations(auth, query.limit, query.leadId);
  }

  @Get('conversations/:id/messages')
  listMessages(@CurrentAuth() auth: AuthContext, @Param('id', ParseUUIDPipe) id: string) {
    return this.history.listMessages(auth, id);
  }

  @Get('messages')
  listLeadMessages(@CurrentAuth() auth: AuthContext, @Query() query: LeadMessagesQuery) {
    return this.history.listMessages(auth, query.leadId);
  }
}
