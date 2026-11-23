/**
 * Demo data for local development: one organization with an owner you can
 * sign in as, a few agents, and leads at every stage with their calls,
 * texts and timeline.
 *
 *   pnpm seed:demo                      # create (or recreate) the demo org
 *   pnpm seed:demo -- --remove          # delete the demo org and everything in it
 *   pnpm seed:demo -- --allow-remote    # DATABASE_URL is not on this machine
 *
 * Sign in with DEMO_EMAIL / DEMO_PASSWORD (defaults below). The email is
 * already verified, so no confirmation mail is needed.
 *
 * Safe to re-run: it only ever touches the organization that owns the demo
 * email, which it deletes and builds again. Nothing else in the database is
 * read or changed.
 *
 * Nobody real can be contacted: every phone is a reserved fictional
 * 555-01xx number, every email is @example.com, and every lead has
 * automation paused, so no AI call or text is ever started for them.
 *
 * Guards: refuses a database whose name contains "prod", and a database on
 * another machine unless --allow-remote is passed.
 */
import 'dotenv/config';
import { randomBytes, scrypt as scryptCb } from 'node:crypto';
import { promisify } from 'node:util';
import { PrismaClient } from '@prisma/client';

const DEMO_EMAIL = process.env.DEMO_EMAIL ?? 'demo@estatepulse.local';
const DEMO_PASSWORD = process.env.DEMO_PASSWORD ?? 'Demo@12345';
const ORG_NAME = 'Demo Realty';
const TIMEZONE = 'America/New_York';

const args = new Set(process.argv.slice(2));

// ---------------------------------------------------------------------------
// Guards
// ---------------------------------------------------------------------------

function checkDatabase() {
  const raw = process.env.DATABASE_URL;
  if (!raw) fail('DATABASE_URL is not set.');
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail('DATABASE_URL is not a valid URL.');
  }
  const db = url.pathname.replace(/^\//, '');
  const host = url.hostname;
  if (/prod/i.test(db)) {
    fail(`Refusing to seed demo data into "${db}": the name looks like production.`);
  }
  const local = ['localhost', '127.0.0.1', '::1', '[::1]', 'postgres', 'db'].includes(host);
  if (!local && !args.has('--allow-remote')) {
    fail(`DATABASE_URL points at ${host}, not this machine. Re-run with --allow-remote if that is intended.`);
  }
  return `${host}/${db}`;
}

function fail(message) {
  console.error(`\n✖ ${message}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const scrypt = promisify(scryptCb);

/** Same format as src/common/utils/password.ts, so the normal login accepts it. */
async function hashPassword(password) {
  const salt = randomBytes(12);
  const hash = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString('hex')}$${hash.toString('hex')}`;
}

/** A small seeded PRNG, so every run builds the same demo. */
let seed = 20261116;
const rand = () => {
  seed = (seed * 1664525 + 1013904223) % 4294967296;
  return seed / 4294967296;
};
const pick = (list) => list[Math.floor(rand() * list.length)];
const between = (min, max) => Math.floor(min + rand() * (max - min + 1));

const now = Date.now();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms) => new Date(now - ms);

/** Reserved fictional numbers (555-0100 … 555-0199): they never reach a real phone. */
const AREA_CODES = ['212', '305', '310', '512', '617', '702', '720', '312'];
const fakePhone = (i) => {
  const area = AREA_CODES[i % AREA_CODES.length];
  const line = String(100 + (i % 100)).padStart(4, '0');
  return { display: `+1 (${area}) 555-${line}`, e164: `+1${area}555${line}` };
};

// ---------------------------------------------------------------------------
// Demo content
// ---------------------------------------------------------------------------

const AGENTS = [
  { firstName: 'Sarah', lastName: 'Mitchell' },
  { firstName: 'David', lastName: 'Chen' },
  { firstName: 'Priya', lastName: 'Sharma' },
  { firstName: 'Marcus', lastName: 'Johnson' },
];

const FIRST = ['Emily', 'James', 'Olivia', 'Michael', 'Sophia', 'Daniel', 'Ava', 'Matthew', 'Isabella', 'Ryan',
  'Mia', 'Ethan', 'Charlotte', 'Noah', 'Amelia', 'Lucas', 'Harper', 'Benjamin', 'Ella', 'Henry', 'Grace',
  'Jack', 'Chloe', 'Samuel', 'Zoe', 'Owen', 'Lily', 'Nathan', 'Aria', 'Leo', 'Nora', 'Caleb', 'Hannah',
  'Aaron', 'Layla', 'Isaac', 'Ruby', 'Gabriel', 'Stella', 'Julian'];
const LAST = ['Carter', 'Nguyen', 'Patel', 'Rodriguez', 'Thompson', 'Kim', 'Walker', 'Martinez', 'Brooks',
  'Foster', 'Reed', 'Hughes', 'Price', 'Bennett', 'Russell', 'Coleman', 'Hayes', 'Ward', 'Ross', 'Perry'];

const LOCATIONS = ['Austin, TX', 'Miami, FL', 'Denver, CO', 'Boston, MA', 'Los Angeles, CA', 'Chicago, IL',
  'Las Vegas, NV', 'Brooklyn, NY', 'Round Rock, TX', 'Coral Gables, FL'];
const INTENTS = ['buy', 'sell', 'buy', 'rent', 'buy', 'invest'];
const TIMELINES = ['ASAP', 'Within 30 days', '1-3 months', '3-6 months', '6+ months'];
const FINANCING = ['Pre-approved', 'Cash buyer', 'Talking to a lender', 'Not started'];
const UTM = [
  { utmSource: 'facebook', utmMedium: 'paid_social', utmCampaign: 'spring_open_house' },
  { utmSource: 'google', utmMedium: 'cpc', utmCampaign: 'homes_for_sale' },
  { utmSource: 'zillow', utmMedium: 'referral', utmCampaign: null },
  { utmSource: 'website', utmMedium: 'organic', utmCampaign: null },
];

/** How many leads per status, with the temperature and score range that fits it. */
const PLAN = [
  { status: 'new', count: 8, temp: 'cold', score: [5, 25] },
  { status: 'contacting', count: 6, temp: 'cold', score: [10, 30] },
  { status: 'engaged', count: 6, temp: 'warm', score: [40, 60] },
  { status: 'follow_up', count: 5, temp: 'warm', score: [35, 55] },
  { status: 'interested', count: 5, temp: 'hot', score: [70, 85] },
  { status: 'appointment_requested', count: 3, temp: 'hot', score: [75, 90] },
  { status: 'appointment_booked', count: 5, temp: 'hot', score: [82, 98] },
  { status: 'not_interested', count: 3, temp: 'cold', score: [5, 20] },
  { status: 'unresponsive', count: 3, temp: 'cold', score: [5, 15] },
  { status: 'closed', count: 2, temp: 'hot', score: [90, 99] },
];

const FOLLOW_UP_REASONS = ['no_answer', 'not_ready', 'callback_requested', 'needs_time'];

const SUMMARIES = {
  engaged: 'Replied by text and is looking at {beds}-bedroom homes in {loc}. Budget around {budget}. Wants to know about schools nearby.',
  follow_up: 'Interested but not ready yet. Asked to be contacted again in a couple of weeks once their lease situation is clear.',
  interested: 'Strong buyer: {fin}, {beds} bedrooms in {loc}, budget up to {budget}. Wants to see listings this week.',
  appointment_requested: 'Asked for a showing in {loc}. Prefers weekday evenings. {fin}.',
  appointment_booked: 'Showing booked for a {beds}-bedroom home in {loc}. {fin}, timeline {timeline}.',
  not_interested: 'Said they already bought through another agent. Polite, no further contact wanted.',
  closed: 'Closed on a {beds}-bedroom home in {loc}. Very happy with the process; open to referrals.',
};

const TRANSCRIPT = (lead, agentLine) =>
  [
    `AI: Hi ${lead.firstName}, this is the EstatePulse assistant calling for ${ORG_NAME}. You asked about homes in ${lead.location} — is now a good time?`,
    `${lead.firstName}: Yes, sure, I have a few minutes.`,
    `AI: Great. Are you looking to buy soon, and how many bedrooms do you need?`,
    `${lead.firstName}: Within the next couple of months, ideally ${lead.bedrooms} bedrooms.`,
    `AI: And do you have a budget in mind, or have you spoken with a lender yet?`,
    `${lead.firstName}: ${lead.financingStatus}. Somewhere around ${money(lead.maxBudget)}.`,
    `AI: ${agentLine}`,
  ].join('\n');

const money = (n) => `$${Math.round(n / 1000)}k`;

// ---------------------------------------------------------------------------
// Remove
// ---------------------------------------------------------------------------

async function removeDemo(prisma) {
  const owner = await prisma.user.findUnique({ where: { email: DEMO_EMAIL }, select: { orgId: true } });
  if (!owner) return false;
  // user_roles -> roles is ON DELETE RESTRICT, so clear it before the org cascade.
  await prisma.userRole.deleteMany({ where: { user: { orgId: owner.orgId } } });
  await prisma.organization.delete({ where: { id: owner.orgId } });
  return true;
}

// ---------------------------------------------------------------------------
// Build
// ---------------------------------------------------------------------------

async function buildDemo(prisma) {
  const password = await hashPassword(DEMO_PASSWORD);

  const org = await prisma.organization.create({
    data: { name: ORG_NAME, settings: { create: { timezone: TIMEZONE } } },
  });
  const ownerRole = await prisma.role.create({
    data: { orgId: org.id, name: 'Owner', description: 'Full access to everything in the organization.', isSystem: true, permissions: [] },
  });
  const agentRole = await prisma.role.create({
    data: { orgId: org.id, name: 'Agent', description: 'Works leads assigned to them.', isSystem: false, permissions: [] },
  });

  const verified = ago(30 * DAY);
  const owner = await prisma.user.create({
    data: {
      orgId: org.id,
      firstName: 'Alex',
      lastName: 'Morgan',
      email: DEMO_EMAIL,
      phone: fakePhone(0).display,
      password,
      timezone: TIMEZONE,
      emailVerifiedAt: verified,
      roles: { create: [{ roleId: ownerRole.id }, { roleId: agentRole.id }] },
    },
  });

  const agents = [];
  for (const [i, a] of AGENTS.entries()) {
    agents.push(
      await prisma.user.create({
        data: {
          orgId: org.id,
          ...a,
          email: `${a.firstName.toLowerCase()}.${a.lastName.toLowerCase()}@example.com`,
          phone: fakePhone(i + 1).display,
          password,
          timezone: TIMEZONE,
          emailVerifiedAt: verified,
          roles: { create: [{ roleId: agentRole.id }] },
        },
      }),
    );
  }
  const team = [owner, ...agents];

  const source = await prisma.leadSource.create({
    data: {
      orgId: org.id,
      name: 'Demo import',
      code: 'demo-import',
      provider: 'FILE_UPLOAD',
      connectionMethod: 'UPLOAD',
      ingestStatus: 'COMPLETED',
      mappingStatus: 'CONFIGURED',
      lastEventAt: ago(2 * HOUR),
      lastSuccessAt: ago(2 * HOUR),
    },
  });

  let n = 0;
  let calls = 0;
  let texts = 0;
  for (const plan of PLAN) {
    for (let k = 0; k < plan.count; k++, n++) {
      const firstName = FIRST[n % FIRST.length];
      const lastName = LAST[(n * 7) % LAST.length];
      const phone = fakePhone(n + 10);
      const email = `${firstName}.${lastName}${n}@example.com`.toLowerCase();
      const createdAt = ago(between(1, 21) * DAY + between(0, 23) * HOUR);
      const minBudget = between(30, 90) * 10_000;
      const maxBudget = minBudget + between(5, 30) * 10_000;
      const bedrooms = between(1, 5);
      const location = pick(LOCATIONS);
      const financingStatus = pick(FINANCING);
      const timeline = pick(TIMELINES);
      const contacted = plan.status !== 'new';
      const talked = !['new', 'contacting', 'unresponsive'].includes(plan.status);
      const agent = ['interested', 'appointment_requested', 'appointment_booked', 'closed'].includes(plan.status) || rand() < 0.4
        ? team[n % team.length]
        : null;
      const summary = SUMMARIES[plan.status]
        ?.replace('{beds}', String(bedrooms))
        .replace('{loc}', location)
        .replace('{budget}', money(maxBudget))
        .replace('{fin}', financingStatus)
        .replace('{timeline}', timeline.toLowerCase());

      const lead = await prisma.lead.create({
        data: {
          orgId: org.id,
          leadSourceId: source.id,
          firstName,
          lastName,
          email,
          normalizedEmail: email,
          emailValid: true,
          phone: phone.display,
          normalizedPhone: phone.e164,
          phoneValid: true,
          timezone: TIMEZONE,
          status: plan.status,
          followUpReason: plan.status === 'follow_up' ? pick(FOLLOW_UP_REASONS) : null,
          temperature: plan.temp,
          score: between(plan.score[0], plan.score[1]),
          aiSummary: talked ? summary ?? null : null,
          lostReason: plan.status === 'not_interested' ? 'Bought with another agent' : null,
          buyingIntent: pick(INTENTS),
          timeline,
          minBudget,
          maxBudget,
          financingStatus,
          location,
          bedrooms,
          motivation: talked ? pick(['Growing family', 'Relocating for work', 'Downsizing', 'First home', 'Investment property']) : null,
          ...pick(UTM),
          consentStatus: 'granted',
          consentSource: 'demo',
          consentAt: createdAt,
          // Demo leads must never be called or texted for real.
          automationPaused: true,
          assignedToId: agent?.id ?? null,
          assignedAt: agent ? new Date(createdAt.getTime() + 2 * HOUR) : null,
          assignmentType: agent ? (rand() < 0.5 ? 'ai' : 'manual') : null,
          firstContactAt: contacted ? new Date(createdAt.getTime() + between(1, 5) * MIN) : null,
          firstResponseAt: talked ? new Date(createdAt.getTime() + between(10, 90) * MIN) : null,
          lastContactAt: contacted ? ago(between(1, 48) * HOUR) : null,
          lastSubmissionAt: createdAt,
          createdAt,
        },
      });

      if (plan.status !== 'new') {
        await prisma.leadEvent.create({
          data: {
            orgId: org.id,
            leadId: lead.id,
            type: 'status_changed',
            fromStatus: 'new',
            toStatus: plan.status,
            source: talked ? 'call' : 'strategy',
            actorType: 'ai',
            createdAt: new Date(createdAt.getTime() + 30 * MIN),
          },
        });
      }

      // Texts: the first-touch message, and a short exchange once the lead replied.
      if (contacted) {
        const first = new Date(createdAt.getTime() + 2 * MIN);
        const thread = [
          { direction: 'outbound', senderType: 'ai', body: `Hi ${firstName}, thanks for your interest in homes in ${location}! I'm the assistant for ${ORG_NAME}. Are you looking to buy soon?`, at: first },
        ];
        if (talked) {
          thread.push(
            { direction: 'inbound', senderType: 'lead', body: `Hi! Yes, looking for ${bedrooms} bedrooms, around ${money(maxBudget)}.`, at: new Date(first.getTime() + 25 * MIN) },
            { direction: 'outbound', senderType: 'ai', body: `Great — I'll pull together a few options in ${location}. Is a quick call later today okay?`, at: new Date(first.getTime() + 26 * MIN) },
            { direction: 'inbound', senderType: 'lead', body: pick(['Sure, after 5pm works.', 'Yes please!', 'Tomorrow morning is better.']), at: new Date(first.getTime() + 40 * MIN) },
          );
        }
        if (agent && ['appointment_booked', 'closed'].includes(plan.status)) {
          thread.push({
            direction: 'outbound',
            senderType: 'user',
            senderUserId: agent.id,
            body: `Hi ${firstName}, ${agent.firstName} here from ${ORG_NAME}. Looking forward to showing you the place!`,
            at: new Date(first.getTime() + 3 * HOUR),
          });
        }
        for (const m of thread) {
          await prisma.message.create({
            data: {
              orgId: org.id,
              leadId: lead.id,
              direction: m.direction,
              senderType: m.senderType,
              senderUserId: m.senderUserId ?? null,
              body: m.body,
              deliveryStatus: 'delivered',
              sentAt: m.at,
              deliveredAt: m.at,
              createdAt: m.at,
            },
          });
          texts++;
        }
      }

      // Calls: unanswered attempts for the quiet ones, a real conversation for the rest.
      if (contacted) {
        const startedAt = new Date(createdAt.getTime() + between(5, 60) * MIN);
        const connected = talked;
        const duration = connected ? between(95, 420) : between(0, 25);
        await prisma.call.create({
          data: {
            orgId: org.id,
            leadId: lead.id,
            status: connected ? 'completed' : 'no_answer',
            disposition: connected ? 'connected' : pick(['no_answer', 'voicemail', 'busy']),
            startedAt,
            endedAt: new Date(startedAt.getTime() + duration * 1000),
            durationSeconds: duration,
            transcript: connected
              ? TRANSCRIPT(
                  { firstName, location, bedrooms, financingStatus, maxBudget },
                  plan.status === 'not_interested'
                    ? 'Understood, thanks for letting me know. Best of luck with the new home!'
                    : 'Perfect, I will have one of our agents reach out with a few listings that match.',
                )
              : null,
            aiSummary: connected ? summary ?? null : null,
            extractedIntel: connected ? { bedrooms, location, timeline, financingStatus, maxBudget } : undefined,
            handoffRequested: connected && plan.temp === 'hot',
            createdAt: startedAt,
          },
        });
        calls++;
      }
    }
  }

  return { org, leads: n, agents: agents.length, calls, texts };
}

// ---------------------------------------------------------------------------

async function main() {
  const target = checkDatabase();
  const prisma = new PrismaClient();
  try {
    const removed = await removeDemo(prisma);
    if (args.has('--remove')) {
      console.log(removed ? `\n✔ Removed the demo organization from ${target}.\n` : '\nNo demo organization to remove.\n');
      return;
    }
    const result = await buildDemo(prisma);
    console.log(`\n✔ Demo data ready in ${target}${removed ? ' (previous demo replaced)' : ''}`);
    console.log(`  Organization : ${result.org.name}`);
    console.log(`  Team         : 1 owner + ${result.agents} agents`);
    console.log(`  Leads        : ${result.leads}  ·  calls ${result.calls}  ·  texts ${result.texts}`);
    console.log(`\n  Sign in      : ${DEMO_EMAIL}  /  ${DEMO_PASSWORD}\n`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
