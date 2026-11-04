import { describe, expect, it } from 'vitest';
import { TelnyxController } from './telnyx.controller';

const OUR_NUMBER = '+12025550123';
const SOMEONE_ELSES = '+13125550199';
const KEY = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA0=';

const auth = { organizationId: 'org-b' } as any;

/** The connect endpoint, with Telnyx answering only for the numbers this key owns. */
const controller = (saved: Record<string, unknown>[]) =>
  new TelnyxController(
    {
      getCreds: async () => ({ apiKey: 'KEY-b', publicKey: KEY, fromNumber: '', connectionId: 'app-1' }),
      saveCreds: async (_orgId: string, patch: Record<string, unknown>) => void saved.push(patch),
      findCallControlApp: async () => 'app-1',
      findMessagingProfile: async () => 'mp-1',
      publicStatus: async () => ({}),
    } as any,
    {} as any,
    { ownsNumber: async (_key: string, number: string) => number === OUR_NUMBER } as any,
    { pushToTelnyx: async () => undefined } as any,
  );

const connect = (fromNumber: string, saved: Record<string, unknown>[] = []) =>
  controller(saved).saveCredentials(auth, { fromNumber } as any);

describe('an organization can only connect a number its own Telnyx key owns', () => {
  it('refuses a number that belongs to someone else', async () => {
    const saved: Record<string, unknown>[] = [];
    await expect(connect(SOMEONE_ELSES, saved)).rejects.toThrow(/not on the Telnyx account/);
    expect(saved).toEqual([]);
  });

  it('accepts one the key owns, however it was typed, and stores it as the webhooks look it up', async () => {
    const saved: Record<string, unknown>[] = [];
    await connect('+1 (202) 555-0123', saved);
    expect(saved).toEqual([expect.objectContaining({ fromNumber: OUR_NUMBER })]);
  });
});
