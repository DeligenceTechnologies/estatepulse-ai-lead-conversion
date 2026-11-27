import { z } from 'zod';
import type { ConnectedAppsService } from '@/integration/connected-apps.service';
import { readTool, type AssistantTool } from './tool';

/** The screen a connection is fixed on, as the user finds it in the app. */
const SCREEN: Record<string, string> = {
  '/settings?tab=telnyx': 'Settings > Telnyx',
  '/settings?tab=calendar': 'Settings > Calendar',
  '/integrations': 'Lead Integrations',
};

export function appTools(apps: ConnectedAppsService): AssistantTool[] {
  return [
    readTool({
      name: 'integration_status',
      label: 'Checking connected apps',
      description:
        "The office's connected apps (phone and texting, calendar, CRMs, lead forms) and whether each one works, with what a broken one stops and the screen where it is fixed. Use it when something fails, to say which app needs fixing.",
      permissions: [],
      input: z.object({}).strict(),
      async run({ auth }) {
        const { apps: list, canReconnect } = await apps.list(auth);
        return {
          apps: list.map((a) => ({
            app: a.label,
            state: a.state,
            ...(a.account ? { account: a.account } : {}),
            lastSync: a.lastSyncAt,
            ...(a.message ? { problem: a.message } : {}),
            fixedOn: SCREEN[a.reconnectPath] ?? a.reconnectPath,
          })),
          // Only these users can sign an app in again; others should ask an admin.
          userCanReconnect: canReconnect,
          ...(list.length === 0 ? { note: 'No apps are connected yet.' } : {}),
        };
      },
    }),
  ];
}
