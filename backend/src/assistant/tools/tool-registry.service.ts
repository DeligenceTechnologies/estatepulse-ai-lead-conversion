import { Injectable } from '@nestjs/common';
import { z } from 'zod';
import type { AuthContext } from '@/auth/auth.types';
import { AppointmentsService } from '@/calendar/appointments/appointments.service';
import { InCallBookingSettingsService } from '@/calendar/booking/in-call-booking-settings.service';
import { InCallBookingService } from '@/calendar/booking/in-call-booking.service';
import { LeadBookingService } from '@/calendar/booking/lead-booking.service';
import { PrismaService } from '@/common/prisma/prisma.service';
import { EventsBus } from '@/events/events.bus';
import { FollowupService } from '@/followup/followup.service';
import { HistoryService } from '@/history/history.service';
import { LeadAssignmentService } from '@/lead/lead-assignment.service';
import { LeadEditService } from '@/lead/lead-edit.service';
import { LeadReviewService } from '@/lead/lead-review.service';
import { LeadStateService } from '@/lead/lead-state.service';
import { ManualLeadService } from '@/lead/manual-lead.service';
import { EngineService } from '@/telnyx/engine.service';
import { OptOutService } from '@/telnyx/opt-out.service';
import { SmsService } from '@/telnyx/sms.service';
import { SmsConversationService } from '@/telnyx/sms/sms-conversation.service';
import { StrategyStoreService } from '@/telnyx/strategy-store.service';
import { calendarTools } from './calendar.tools';
import { historyTools } from './history.tools';
import type { LeadTextDeps } from './lead-text';
import { leadTools, leadVersion } from './lead.tools';
import { outreachTools } from './outreach.tools';
import type { ToolSpec } from '../providers/model-provider';
import type { AssistantTool } from './tool';

/** The catalog of what the assistant can do. Each tool wraps a service the UI already uses. */
@Injectable()
export class ToolRegistry {
  private readonly tools: ReadonlyMap<string, AssistantTool>;
  private readonly definitions: ReadonlyMap<string, ToolSpec>;

  constructor(
    private readonly prisma: PrismaService,
    edits: LeadEditService,
    assignments: LeadAssignmentService,
    manualLeads: ManualLeadService,
    reviews: LeadReviewService,
    history: HistoryService,
    appointments: AppointmentsService,
    booking: InCallBookingService,
    bookingSettings: InCallBookingSettingsService,
    leadBooking: LeadBookingService,
    sms: SmsService,
    conversations: SmsConversationService,
    optOuts: OptOutService,
    engine: EngineService,
    strategies: StrategyStoreService,
    followup: FollowupService,
    state: LeadStateService,
    events: EventsBus,
  ) {
    const text: LeadTextDeps = { prisma, sms, conversations, optOuts, followup, state, events };
    const all = [
      ...leadTools({ prisma, edits, assignments, manualLeads, reviews }),
      ...historyTools(history, prisma),
      ...calendarTools({ prisma, appointments, booking, bookingSettings, leadBooking, text }),
      ...outreachTools({ prisma, engine, strategies, followup, state, text }),
    ].sort((a, b) => a.name.localeCompare(b.name));
    this.tools = new Map(all.map((t) => [t.name, t]));
    this.definitions = new Map(all.map((t) => [t.name, toDefinition(t)]));
  }

  get(name: string): AssistantTool | undefined {
    return this.tools.get(name);
  }

  allows(auth: AuthContext, tool: AssistantTool): boolean {
    return tool.permissions.every((p) => auth.permissions.includes(p));
  }

  /** Only the tools this user may run, in a stable order so the cached prompt prefix stays the same. */
  definitionsFor(auth: AuthContext): ToolSpec[] {
    return [...this.tools.values()].filter((t) => this.allows(auth, t)).map((t) => this.definitions.get(t.name)!);
  }

  /** The current version of the entity a proposal was built against, to catch edits made in between. */
  entityVersion(orgId: string, entity: { type: string; id: string }): Promise<Date | null> {
    return leadVersion(this.prisma, orgId, entity.id);
  }
}

function toDefinition(tool: AssistantTool): ToolSpec {
  const { $schema: _ignored, ...schema } = z.toJSONSchema(tool.input, { io: 'input' }) as Record<string, unknown>;
  return {
    name: tool.name,
    description: tool.tier === 'write' ? `${tool.description} The user confirms before it runs.` : tool.description,
    inputSchema: { type: 'object', ...schema },
  };
}
