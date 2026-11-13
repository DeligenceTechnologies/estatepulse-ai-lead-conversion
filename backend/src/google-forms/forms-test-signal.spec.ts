import { describe, expect, it } from 'vitest';

import { GOOGLE_FORMS_EVENT_TYPE, GOOGLE_FORMS_RECOVERED_EVENT_TYPE } from './constants';
import { GoogleFormsService } from './google-forms.service';

/**
 * "Test connection" exists to tell an owner whether the script on their form is
 * delivering. The recovery poll writes ingest events for the same responses, so
 * counting every event would call a form healthy while every push is failing —
 * the one failure this check is here to catch.
 */
const serviceWith = (counts: { eventType: string; _count: number }[]) => {
  const prisma = {
    leadSource: {
      findFirst: async () => ({
        id: 'src-1',
        integrationId: 'conn-1',
        externalFormId: 'form-1',
        remoteSyncedAt: null,
        remoteErrorCode: null,
        remoteErrorMessage: null,
      }),
    },
    ingestEvent: {
      groupBy: async () => counts,
      findFirst: async () => (counts.length ? { receivedAt: new Date(), outcome: 'PROCESSED', outcomeReason: null, errorMessage: null } : null),
    },
  };
  // readForm goes through the connection; this test is only about the counting.
  const connections = { withAccessToken: async () => { throw new Error('offline'); } };
  return new GoogleFormsService(prisma as never, connections as never, {} as never, {} as never, {} as never, {} as never);
};

describe('Google Forms "Test connection" delivery signal', () => {
  it('does not call the script installed when only the recovery poll has delivered', async () => {
    const result = await serviceWith([{ eventType: GOOGLE_FORMS_RECOVERED_EVENT_TYPE, _count: 7 }]).test('org', 'src-1');
    expect(result.scriptInstalled).toBe(false);
    expect(result.pushDeliveries).toBe(0);
    expect(result.recoveredDeliveries).toBe(7);
    expect(result.deliveries).toBe(7);
  });

  it('calls it installed as soon as the script itself posts once', async () => {
    const result = await serviceWith([
      { eventType: GOOGLE_FORMS_EVENT_TYPE, _count: 2 },
      { eventType: GOOGLE_FORMS_RECOVERED_EVENT_TYPE, _count: 5 },
    ]).test('org', 'src-1');
    expect(result.scriptInstalled).toBe(true);
    expect(result.pushDeliveries).toBe(2);
    expect(result.recoveredDeliveries).toBe(5);
    expect(result.deliveries).toBe(7);
  });

  it('reports nothing at all when no response has arrived by either route', async () => {
    const result = await serviceWith([]).test('org', 'src-1');
    expect(result.scriptInstalled).toBe(false);
    expect(result.deliveries).toBe(0);
    expect(result.recoveredDeliveries).toBe(0);
  });
});
