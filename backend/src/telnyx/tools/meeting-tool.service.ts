import { Injectable } from '@nestjs/common';
import { existingMeetingSay, meetingFacts, type MeetingFacts } from '@/calendar/booking/existing-meeting';
import { PrismaService } from '@/common/prisma/prisma.service';
import { nextMeeting } from '@/lead/upcoming-meeting';
import type { AssistantToolCaller } from './assistant-tool-auth.service';

export type MeetingLookup = ({ ok: true; say: string } & MeetingFacts) | { ok: true; meeting: null; say: string };

/**
 * get_meeting: the meeting the lead already has, looked up when the AI asks.
 * A variable would not do: Telnyx reads a text chat's variables only when the
 * chat starts, and a chat can outlive a booking, a move or a cancellation.
 */
@Injectable()
export class MeetingToolService {
  constructor(private readonly prisma: PrismaService) {}

  async lookup(caller: AssistantToolCaller): Promise<MeetingLookup> {
    const [meeting, settings] = await Promise.all([
      nextMeeting(this.prisma, caller.orgId, caller.leadId),
      this.prisma.organizationSetting.findUnique({ where: { orgId: caller.orgId }, select: { timezone: true } }),
    ]);
    if (!meeting) return { ok: true, meeting: null, say: 'They have no upcoming meeting with us. If they want one, offer to set one up.' };
    const facts = meetingFacts(meeting, settings?.timezone || 'UTC');
    return { ok: true, say: existingMeetingSay(facts), ...facts };
  }
}
