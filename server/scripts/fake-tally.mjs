#!/usr/bin/env node
/**
 * A stand-in for api.tally.so, for testing the connect flow end to end.
 *
 *   node scripts/fake-tally.mjs [port]        # default 8787
 *
 * Point the API at it:
 *   TALLY_API_BASE_URL=http://localhost:8787 ALLOW_INSECURE_INGEST_URL=true npm run dev
 *
 * Why this exists rather than testing against real Tally:
 *
 *  - A real account cannot produce a 500 on demand, and the 500-during-install
 *    path is the one that decides whether a failed connect is rolled back or
 *    reconciled. That branch is the most dangerous code in the feature and the
 *    least likely to be exercised by hand.
 *  - It exposes what real Tally never will: the URL and signing secret it was
 *    handed. That lets a test sign a payload with the secret WE installed and
 *    post it to the URL WE registered, proving the API-key path lands on the
 *    byte-identical existing ingest route.
 *
 * Shapes below mirror a real account (form `lbxX8o`), including the awkward
 * bits: a question with a null title, and options living in GET /forms/{id}
 * rather than in /questions.
 *
 * No dependencies. In-memory. Not for production — it authenticates nothing
 * beyond the presence of a bearer token.
 */

import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';

const PORT = Number(process.argv[2] ?? 8787);

/** Queued failures, newest first, set via POST /__control. */
let failNext = null;
/** Webhooks created through POST /webhooks. */
const webhooks = new Map();

const GROUP_TIMELINE = 'acd28a62-ce7c-4d2c-aed8-c9f159b2cb4c';
const GROUP_AREAS = '4bc3d1de-3dc7-443b-84d4-507fffeace16';
const GROUP_CONSENT = 'cfda3201-4c08-45f8-93f2-2bbf7d452158';

const QUESTIONS = [
  q('2xELzL', 'INPUT_TEXT', 'First name', '879fa960-7bc8-408e-baa1-6edce6c83d3a'),
  q('xNX2Ey', 'INPUT_TEXT', 'Last name', 'd207f4b8-3faa-4b58-816f-d60fb99f4d33'),
  q('RBGR1J', 'INPUT_EMAIL', 'Email', 'cbb3b62f-cca6-469d-9511-add23625bb5f'),
  // Null title on purpose: this is the consent checkbox, and it is the shape
  // that breaks any code assuming a question has a label.
  q('V1LVXv', 'CHECKBOXES', null, GROUP_CONSENT),
  q('d2EggK', 'INPUT_PHONE_NUMBER', 'Number we can reach you on', 'aaaaaaaa-0000-0000-0000-000000000001'),
  q('YzPeeJ', 'MULTIPLE_CHOICE', 'When are you hoping to move?', GROUP_TIMELINE),
  q('DvBbbZ', 'CHECKBOXES', 'Which areas are you looking at?', GROUP_AREAS),
];

const BLOCKS = [
  { type: 'FORM_TITLE', uuid: 'c745a878', groupUuid: '7850b95f', payload: { text: 'Lead generation form' } },
  { type: 'TEXT', uuid: '3c71b824', groupUuid: 'bd5535d8', payload: { text: 'Your information' } },
  opt('CHECKBOX', '5492dbea', GROUP_CONSENT, null, 0),
  opt('MULTIPLE_CHOICE_OPTION', '8e5da791', GROUP_TIMELINE, '1-3 months', 0),
  opt('MULTIPLE_CHOICE_OPTION', '5a527a59', GROUP_TIMELINE, '3-6 months', 1),
  opt('MULTIPLE_CHOICE_OPTION', '6dccb338', GROUP_TIMELINE, '6+ months', 2),
  opt('CHECKBOX', '6df9b961', GROUP_AREAS, 'North Austin / The Domain', 0),
  opt('CHECKBOX', 'e30f3376', GROUP_AREAS, 'Downtown', 1),
  opt('CHECKBOX', 'f3f479c9', GROUP_AREAS, 'South Congress', 2),
];

function q(id, type, title, groupUuid) {
  return {
    id,
    type,
    title,
    formId: 'lbxX8o',
    isDeleted: false,
    fields: [{ uuid: groupUuid, type: 'INPUT_FIELD', questionType: type, blockGroupUuid: groupUuid, title: title ?? '' }],
  };
}

function opt(type, uuid, groupUuid, text, index) {
  return { type, groupType: type === 'CHECKBOX' ? 'CHECKBOXES' : 'MULTIPLE_CHOICE', uuid, groupUuid, payload: text === null ? { index } : { index, text } };
}

const send = (res, status, body, headers = {}) => {
  const payload = typeof body === 'string' ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
  res.end(payload);
};

const readBody = (req) =>
  new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        resolve({});
      }
    });
  });

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);
  const path = url.pathname;

  // --- control plane: everything real Tally will not do on demand -----------
  if (path === '/__control' && req.method === 'POST') {
    failNext = await readBody(req);
    return send(res, 200, { ok: true, failNext });
  }
  if (path === '/__control/state') {
    // The whole point: hand back the URL and secret we were given, so a test can
    // sign a payload with the secret WE installed and post it where WE said.
    return send(res, 200, { webhooks: [...webhooks.values()] });
  }
  if (path === '/__control/reset' && req.method === 'POST') {
    webhooks.clear();
    failNext = null;
    return send(res, 200, { ok: true });
  }

  // --- injected failure -----------------------------------------------------
  if (failNext?.status) {
    const { status, retryAfter, body } = failNext;
    failNext = null; // one-shot
    return send(
      res,
      status,
      body ?? `injected ${status}`,
      retryAfter === undefined ? {} : { 'Retry-After': String(retryAfter) },
    );
  }

  if (!(req.headers.authorization ?? '').startsWith('Bearer ')) {
    return send(res, 401, 'Unauthorized');
  }

  // --- the real surface -----------------------------------------------------
  if (path === '/users/me') {
    return send(res, 200, { id: 'usr_fake', email: 'you@example.com', fullName: 'Fake Tally User' });
  }

  if (path === '/forms' && req.method === 'GET') {
    return send(res, 200, {
      items: [
        {
          id: 'lbxX8o',
          name: 'Lead generation form',
          workspaceId: 'm6VJdB',
          status: 'PUBLISHED',
          numberOfSubmissions: 1,
          isClosed: false,
          updatedAt: new Date().toISOString(),
        },
      ],
      page: 1,
      limit: 50,
      total: 1,
      hasMore: false,
    });
  }

  if (path === '/forms/lbxX8o/questions') return send(res, 200, { questions: QUESTIONS });

  // Options live here, NOT in /questions — mirroring real Tally.
  if (path === '/forms/lbxX8o') {
    return send(res, 200, { id: 'lbxX8o', name: 'Lead generation form', status: 'PUBLISHED', blocks: BLOCKS });
  }

  // 401 even with a valid key, exactly like the real API.
  if (path === '/forms/lbxX8o/blocks') return send(res, 401, 'Unauthorized');

  if (path === '/webhooks' && req.method === 'GET') {
    return send(res, 200, { webhooks: [...webhooks.values()], page: 1, limit: 100, hasMore: false, totalCount: webhooks.size });
  }

  if (path === '/webhooks' && req.method === 'POST') {
    const b = await readBody(req);
    if (!b.formId || !b.url) return send(res, 400, 'formId and url are required');
    // Real Tally 404s for a form that does not exist. Accepting anything here
    // made a test look like it passed when the code under test never ran.
    if (b.formId !== 'lbxX8o') return send(res, 404, 'Form not found');

    const hook = {
      id: `wh_${randomUUID().slice(0, 8)}`,
      formId: b.formId,
      url: b.url,
      eventTypes: b.eventTypes ?? ['FORM_RESPONSE'],
      signingSecret: b.signingSecret ?? null,
      externalSubscriber: b.externalSubscriber ?? null,
      isEnabled: true,
      createdAt: new Date().toISOString(),
    };
    webhooks.set(hook.id, hook);
    console.log(`  + webhook ${hook.id} -> ${hook.url}  (ref=${hook.externalSubscriber})`);
    return send(res, 201, hook);
  }

  const whMatch = path.match(/^\/webhooks\/([^/]+)$/);
  if (whMatch) {
    const id = decodeURIComponent(whMatch[1]);
    const existing = webhooks.get(id);
    if (!existing) return send(res, 404, 'Not found');

    if (req.method === 'PATCH') {
      const b = await readBody(req);
      Object.assign(existing, b);
      return send(res, 200, existing);
    }
    if (req.method === 'DELETE') {
      webhooks.delete(id);
      console.log(`  - webhook ${id} removed`);
      return send(res, 204, '');
    }
  }

  send(res, 404, 'Not found');
});

server.listen(PORT, () => {
  console.log(`fake-tally listening on http://localhost:${PORT}`);
  console.log('  POST /__control        {"status":500}  |  {"status":429,"retryAfter":0}  |  {"status":401}');
  console.log('  GET  /__control/state  -> webhooks created, with the URL and secret we were handed');
  console.log('  POST /__control/reset');
});
