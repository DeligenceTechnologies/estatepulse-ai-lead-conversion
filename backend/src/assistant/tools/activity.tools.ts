import { z } from 'zod';
import type { AssistantActivityService } from '../assistant-activity.service';
import { readTool, type AssistantTool } from './tool';

export function activityTools(activity: AssistantActivityService): AssistantTool[] {
  return [
    readTool({
      name: 'activity_feed',
      label: 'Reading recent activity',
      description:
        "What happened in the office lately, newest first: leads that replied, got interested, asked for a meeting or a callback, opted out; meetings booked or canceled; outreach paused or resumed; CRM syncs. Also the approval cards waiting on this user and any broken app. Use it for questions like \"what happened today?\" or \"anything I should look at?\".",
      permissions: [],
      input: z.object({ hours: z.number().int().min(1).max(72).default(24).describe('How far back to look, in hours') }).strict(),
      async run({ auth, refs }, input) {
        const feed = await activity.feed(auth, { hours: input.hours });
        const leadIds = feed.items.flatMap((i) => (i.lead ? [i.lead.id] : []));
        const leadRefs = await refs.issue('lead', leadIds);
        return {
          waitingForYou: feed.needsYou.map((n) => n.title),
          brokenApps: feed.alerts.map((a) => ({ app: a.app, problem: a.message })),
          events: feed.items.map((i) => ({
            at: i.at,
            ...(i.lead ? { lead: { ref: leadRefs.get(i.lead.id)!, name: i.lead.name } } : {}),
            what: i.text,
            ...(i.meetingAt ? { meetingAt: i.meetingAt } : {}),
          })),
          ...(feed.nextCursor ? { note: 'There is more; only the newest are listed.' } : {}),
        };
      },
    }),
  ];
}
