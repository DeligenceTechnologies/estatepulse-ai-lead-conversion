import { describe, expect, it, vi } from 'vitest';
import { REAUTH_ERROR_CODE, forgetExpiredAccess } from './google-connections.service';

describe('reconnecting Google, for the sheets and forms read through it', () => {
  const NOW = new Date('2026-11-20T10:32:59Z');

  async function reconnect() {
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    await forgetExpiredAccess({ leadSource: { updateMany } } as never, 'org-1', 'conn-1', NOW);
    return updateMany.mock.calls.map(([arg]) => arg as { where: Record<string, unknown>; data: Record<string, unknown> });
  }

  it('reads a source that had backed off straight away, instead of hours later', async () => {
    // Live: a form that failed nine times while access was expired was next due six hours after the reconnect.
    const [retry] = await reconnect();
    expect(retry.where).toEqual({ orgId: 'org-1', integrationId: 'conn-1', syncNextAt: { gt: NOW }, syncFailures: { gt: 0 } });
    expect(retry.data).toEqual({ syncNextAt: NOW });
  });

  it('stops a source saying "Reconnect Google" once Google is reconnected', async () => {
    // Live: a paused sheet kept the message after the reconnect, because nothing ever reads a paused sheet again.
    const [, forget] = await reconnect();
    expect(forget.where).toEqual({ orgId: 'org-1', integrationId: 'conn-1', remoteErrorCode: REAUTH_ERROR_CODE });
    expect(forget.data).toEqual({ remoteErrorCode: null, remoteErrorMessage: null, syncFailures: 0 });
  });

  it('never switches a paused sheet back on, and leaves every other problem as it was', async () => {
    const calls = await reconnect();
    expect(calls).toHaveLength(2);
    for (const call of calls) {
      expect(call.where).toMatchObject({ orgId: 'org-1', integrationId: 'conn-1' });
      expect(call.data).not.toHaveProperty('ingestStatus');
      expect(call.data).not.toHaveProperty('isActive');
    }
    // Only a source that already had a next read gets one; a paused one has none to bring forward.
    expect(calls[0].where.syncNextAt).toEqual({ gt: NOW });
  });
});
