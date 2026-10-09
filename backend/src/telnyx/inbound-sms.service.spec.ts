import { describe, expect, it } from 'vitest';
import type { PrismaService, GuardedPrisma } from '../prisma/prisma.service';
import { InboundSmsService } from './inbound-sms.service';

/**
 * Unit suite for the opt-out path.
 *
 * Like agents.service.spec.ts, the prisma double is a tiny in-memory database
 * rather than a canned-value stub: what matters here is *which rows a message
 * leaves behind* — a DNC flag, a stored reply, a cancelled enrollment — and a
 * returns-a-fixed-object mock cannot show any of that.
 *
 * This is the suite that has to stay green. Every other failure in this file's
 * subject costs a stored message; a failure in the STOP path means we keep
 * texting somebody who told us to stop.
 */

const ORG_A = '11111111-1111-4111-8111-111111111111';
const ORG_B = '22222222-2222-4222-8222-222222222222';
const LEAD_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const OUR_NUMBER = '+15125550100';
const LEAD_NUMBER = '+15125550199';

interface LeadRow {
  id: string;
  organization_id: string;
  normalized_phone: string | null;
  status: string;
  follow_up_reason?: string | null;
  lost_reason: string | null;
  dnc_status: boolean;
  automation_paused: boolean;
  consent_status: string;
  first_response_at: Date | null;
  last_contact_at: Date | null;
  created_at: Date;
}
interface MessageRow {
  id: string;
  conversation_id: string;
  organization_id: string;
  direction: string;
  body: string;
  provider_message_id: string | null;
  sender_type: string;
}
interface EnrollmentRow {
  id: string;
  organization_id: string;
  lead_id: string;
  status: string;
  next_action_at: Date | null;
  stopped_reason: string | null;
}

function makeDb(opts: { integrations?: { organization_id: string; status: string; fromNumber: string }[] } = {}) {
  const integrations = opts.integrations ?? [
    { organization_id: ORG_A, status: 'active', fromNumber: OUR_NUMBER },
  ];
  const leads: LeadRow[] = [
    {
      id: LEAD_A,
      organization_id: ORG_A,
      normalized_phone: LEAD_NUMBER,
      status: 'contacting',
      lost_reason: null,
      dnc_status: false,
      automation_paused: false,
      consent_status: 'pending',
      first_response_at: null,
      last_contact_at: null,
      created_at: new Date('2026-09-01'),
    },
  ];
  const messages: MessageRow[] = [];
  const conversations: { id: string; organization_id: string; lead_id: string; channel: string }[] = [];
  const enrollments: EnrollmentRow[] = [
    {
      id: 'e1',
      organization_id: ORG_A,
      lead_id: LEAD_A,
      status: 'active',
      next_action_at: new Date('2026-10-01'),
      stopped_reason: null,
    },
  ];

  let seq = 0;
  const nextId = () => `id-${++seq}`;

  const unscoped = {
    integrations: {
      findMany: async ({ where }: any) => {
        const want = where?.metadata?.equals;
        return integrations
          .filter((i) => where?.provider === 'telnyx' && i.fromNumber === want)
          .map((i) => ({ organization_id: i.organization_id, status: i.status }));
      },
    },
    leads: {
      findFirst: async ({ where }: any) =>
        leads
          .filter(
            (l) =>
              l.organization_id === where.organization_id &&
              l.normalized_phone === where.normalized_phone,
          )
          .sort((a, b) => b.created_at.getTime() - a.created_at.getTime())[0] ?? null,
    },
    messages: {
      findFirst: async ({ where }: any) =>
        messages.find(
          (m) =>
            m.provider_message_id === where.provider_message_id &&
            m.direction === where.direction,
        ) ?? null,
    },
  } as unknown as PrismaService;

  const prisma = {
    conversations: {
      findFirst: async ({ where }: any) =>
        conversations.find(
          (c) =>
            c.organization_id === where.organization_id &&
            c.lead_id === where.lead_id &&
            c.channel === where.channel,
        ) ?? null,
      create: async ({ data }: any) => {
        const row = { id: nextId(), ...data };
        conversations.push(row);
        return row;
      },
    },
    messages: {
      create: async ({ data }: any) => {
        const row = { id: nextId(), ...data };
        messages.push(row);
        return row;
      },
    },
    leads: {
      update: async ({ where, data }: any) => {
        const lead = leads.find((l) => l.id === where.id);
        if (!lead) throw new Error('lead not found');
        Object.assign(lead, data);
        return lead;
      },
      updateMany: async ({ where, data }: any) => {
        const hit = leads.filter(
          (l) => l.id === where.id && (!where.status?.in || where.status.in.includes(l.status)),
        );
        for (const l of hit) Object.assign(l, data);
        return { count: hit.length };
      },
    },
    sequence_enrollments: {
      updateMany: async ({ where, data }: any) => {
        // Mirrors the tenancy guard: a scoped model queried without an
        // organization_id throws rather than quietly matching every tenant.
        if (!where.organization_id) {
          throw new Error('Tenancy guard: sequence_enrollments.updateMany without an organizationId');
        }
        const wanted: string[] = where.status?.in ?? [where.status];
        let count = 0;
        for (const e of enrollments) {
          if (
            e.organization_id === where.organization_id &&
            e.lead_id === where.lead_id &&
            wanted.includes(e.status)
          ) {
            Object.assign(e, data);
            count++;
          }
        }
        return { count };
      },
    },
  } as unknown as GuardedPrisma;

  return {
    svc: new InboundSmsService(prisma, unscoped),
    leads,
    messages,
    conversations,
    enrollments,
  };
}

const inbound = (text: string, over: Record<string, unknown> = {}) => ({
  from: { phone_number: LEAD_NUMBER },
  to: [{ phone_number: OUR_NUMBER }],
  text,
  id: 'msg-1',
  ...over,
});

/**
 * Verbatim from leads_status_check (migration 20261008000001_lead_status_v3),
 * without the retired values nothing should write any more. A value outside
 * this list is a failed write.
 */
const LEAD_STATUSES = [
  'new',
  'contacting',
  'follow_up',
  'interested',
  'appointment_requested',
  'appointment_booked',
  'not_interested',
  'closed',
  'invalid',
];

describe('InboundSmsService', () => {
  it('honours STOP: sets DNC, ends the lead, cancels every scheduled step', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('STOP'));

    const lead = db.leads[0];
    expect(lead.dnc_status).toBe(true);
    expect(lead.automation_paused).toBe(true);
    expect(lead.status).toBe('not_interested');
    expect(lead.lost_reason).toBe('Opted out by SMS');
    expect(lead.consent_status).toBe('revoked');

    // This assertion is the point of the two above it. The handler once wrote
    // a status the constraint of the day rejected, and because that
    // travelled in the same UPDATE as dnc_status the ENTIRE opt-out was lost
    // and the catch swallowed it. The fake below has no CHECK constraint, so
    // the old test passed while the real thing silently kept texting people
    // who had said STOP. Pinning the vocabulary is what makes this test able
    // to fail for the right reason.
    expect(LEAD_STATUSES).toContain(lead.status);

    expect(db.enrollments[0].status).toBe('stopped');
    expect(db.enrollments[0].stopped_reason).toBe('opted_out');
    // Nulled as well as stopped, so the runner's claim query can never see it.
    expect(db.enrollments[0].next_action_at).toBeNull();
  });

  it.each(['stop', 'Stop.', ' UNSUBSCRIBE ', 'quit', 'opt-out'])(
    'treats %j as an opt-out',
    async (text) => {
      const db = makeDb();
      await db.svc.onMessageReceived(inbound(text));
      expect(db.leads[0].dnc_status).toBe(true);
    },
  );

  it('does NOT opt out on a message that merely contains a stop word', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('Can I stop by the open house on Sunday?'));

    expect(db.leads[0].dnc_status).toBe(false);
    // A reply puts the lead back in conversation.
    expect(db.leads[0].status).toBe('contacting');
    expect(db.enrollments[0].status).toBe('paused');
  });

  it('stores the reply and stamps first response', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('Yes please, sounds good'));

    expect(db.messages).toHaveLength(1);
    expect(db.messages[0]).toMatchObject({
      organization_id: ORG_A,
      direction: 'inbound',
      sender_type: 'lead',
      body: 'Yes please, sounds good',
    });
    expect(db.leads[0].first_response_at).toBeInstanceOf(Date);
    // A human is talking to us; a drip message landing mid-conversation reads
    // as nobody being home.
    expect(db.leads[0].automation_paused).toBe(true);
  });

  it('stores an opted-out message too, so the record of why we stopped survives', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('STOP'));
    expect(db.messages).toHaveLength(1);
    expect(db.messages[0].body).toBe('STOP');
  });

  it('ignores a redelivery of the same provider message id', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('hello'));
    await db.svc.onMessageReceived(inbound('hello'));
    expect(db.messages).toHaveLength(1);
  });

  it('START clears DNC but does not resume the cancelled sequence', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(inbound('STOP'));
    await db.svc.onMessageReceived(inbound('START', { id: 'msg-2' }));

    expect(db.leads[0].dnc_status).toBe(false);
    expect(db.leads[0].consent_status).toBe('granted');
    // Reachable again, parked for a person to decide what comes next.
    expect(db.leads[0].status).toBe('follow_up');
    expect(db.leads[0].follow_up_reason).toBe('other');
    // Re-consent to hearing from us is not a request to re-enter a 21-day drip.
    expect(db.enrollments[0].status).toBe('stopped');
    expect(db.leads[0].automation_paused).toBe(true);
  });

  it('writes nothing when no organization owns the number that was texted', async () => {
    const db = makeDb({ integrations: [] });
    await db.svc.onMessageReceived(inbound('STOP'));
    expect(db.messages).toHaveLength(0);
    expect(db.leads[0].dnc_status).toBe(false);
  });

  it('writes nothing when the sender matches no lead in that organization', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived(
      inbound('STOP', { from: { phone_number: '+15125550777' } }),
    );
    expect(db.messages).toHaveLength(0);
    expect(db.leads[0].dnc_status).toBe(false);
  });

  it('still honours a STOP arriving on a disconnected account', async () => {
    const db = makeDb({
      integrations: [{ organization_id: ORG_A, status: 'inactive', fromNumber: OUR_NUMBER }],
    });
    await db.svc.onMessageReceived(inbound('STOP'));
    expect(db.leads[0].dnc_status).toBe(true);
  });

  it('prefers the active account when two organizations hold the same number', async () => {
    const db = makeDb({
      integrations: [
        { organization_id: ORG_B, status: 'inactive', fromNumber: OUR_NUMBER },
        { organization_id: ORG_A, status: 'active', fromNumber: OUR_NUMBER },
      ],
    });
    await db.svc.onMessageReceived(inbound('hello'));
    expect(db.messages[0].organization_id).toBe(ORG_A);
  });

  it('ignores a payload with no usable from/to', async () => {
    const db = makeDb();
    await db.svc.onMessageReceived({ text: 'STOP' });
    expect(db.messages).toHaveLength(0);
    expect(db.leads[0].dnc_status).toBe(false);
  });
});
