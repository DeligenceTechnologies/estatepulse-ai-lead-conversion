import { Injectable } from '@nestjs/common';
import type { CalendarProvider, CalendarWorkspaceType } from '@prisma/client';
import type { BookedMeeting, SchedulingEventType, SchedulingMember, WeeklySchedule } from '../calendar.types';
import { CalClient } from './cal.client';
import { CalendlyClient } from './calendly.client';

/** What the provider needs to know about a connection to read its workspace. */
export interface WorkspaceRef {
  provider: CalendarProvider;
  workspaceType: CalendarWorkspaceType;
  workspaceId: string;
  workspaceSlug: string | null;
}

/**
 * One way to read a connected workspace, whichever provider it is on. The only
 * place that branches on Calendly vs Cal.com (and Cal.com personal vs team)
 * for reads, so the feature services never do.
 */
@Injectable()
export class SchedulingProvider {
  constructor(
    private readonly calendly: CalendlyClient,
    private readonly cal: CalClient,
  ) {}

  members(workspace: WorkspaceRef, secret: string): Promise<SchedulingMember[]> {
    if (workspace.provider === 'calendly') return this.calendly.members(secret, workspace.workspaceId);
    if (workspace.workspaceType === 'personal') return this.cal.personalMember(secret).then((member) => [member]);
    return this.cal.members(secret, workspace.workspaceId);
  }

  /** `knownIds`: event types seen on booked meetings (see `bookedEventTypeIds`), so Calendly's list misses none of them. */
  eventTypes(workspace: WorkspaceRef, secret: string, knownIds: string[] = []): Promise<SchedulingEventType[]> {
    if (workspace.provider === 'calendly') return this.calendly.eventTypes(secret, workspace.workspaceId, knownIds);
    if (workspace.workspaceType === 'personal') return this.cal.personalEventTypes(secret, workspace.workspaceSlug);
    return this.cal.teamEventTypes(secret, workspace.workspaceId, workspace.workspaceSlug);
  }

  /** The event types a member hosts (Calendly: own and shared), by their provider id (Calendly user URI) and username (Cal.com). */
  memberEventTypes(
    workspace: WorkspaceRef,
    secret: string,
    member: { externalId: string; username: string | null },
    knownIds: string[] = [],
  ): Promise<SchedulingEventType[]> {
    if (workspace.provider === 'calendly') {
      return this.calendly.memberEventTypes(secret, workspace.workspaceId, member.externalId, knownIds);
    }
    return member.username ? this.cal.memberEventTypes(secret, member.username) : Promise.resolve([]);
  }

  /**
   * A member's working hours as their calendar has them, or null when the
   * provider does not let us read them: Calendly shows every member's
   * schedule; Cal.com only the API key owner's own.
   */
  async memberSchedule(
    workspace: WorkspaceRef & { accountId: string },
    secret: string,
    memberId: string,
  ): Promise<WeeklySchedule | null> {
    if (workspace.provider === 'calendly') return this.calendly.defaultSchedule(secret, memberId);
    if (memberId !== workspace.accountId) return null;
    return this.cal.defaultSchedule(secret);
  }

  /** Meetings booked in the workspace that start between `from` and `to`. */
  meetings(workspace: WorkspaceRef, secret: string, from: Date, to: Date): Promise<BookedMeeting[]> {
    if (workspace.provider === 'calendly') return this.calendly.scheduledMeetings(secret, workspace.workspaceId, from, to);
    const teamId = workspace.workspaceType === 'personal' ? null : workspace.workspaceId;
    return this.cal.scheduledMeetings(secret, from, to, teamId);
  }

  /** Cheap authenticated call that proves the credentials still work. */
  async verify(provider: CalendarProvider, secret: string): Promise<void> {
    if (provider === 'calendly') await this.calendly.currentUser(secret);
    else await this.cal.me(secret);
  }

  async deleteWebhook(provider: CalendarProvider, secret: string, webhookId: string): Promise<void> {
    if (provider === 'calendly') await this.calendly.deleteWebhook(secret, webhookId);
    else await this.cal.deleteWebhook(secret, webhookId);
  }
}
