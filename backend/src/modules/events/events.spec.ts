import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AuthService } from '../../auth/auth.service';
import { TenantGuard } from '../../common/guards/tenant.guard';
import { EventsBus } from './events.bus';
import { EventsController } from './events.controller';

/**
 * Over real HTTP, not by subscribing to the Observable directly.
 *
 * The parts most likely to break are the ones a direct subscribe skips: whether
 * @Sse() actually frames our objects as `data:` lines, and whether the response
 * streams rather than buffering until close. A test that calls `stream()` and
 * reads the Observable would pass in both worlds.
 *
 * No database and no real guard — the tenancy filter under test is the bus's,
 * and standing up Prisma here would only test Prisma.
 */

const ORG = '11111111-1111-1111-1111-111111111111';
const OTHER_ORG = '22222222-2222-2222-2222-222222222222';

/** Reads `data:` frames off a live stream, the way the browser client does. */
async function* frames(body: ReadableStream<Uint8Array>): AsyncGenerator<Record<string, unknown>> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const data = buffer
        .slice(0, split)
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      buffer = buffer.slice(split + 2);
      if (data) yield JSON.parse(data) as Record<string, unknown>;
      split = buffer.indexOf('\n\n');
    }
  }
}

describe('EventsController — the live stream', () => {
  let app: INestApplication;
  let bus: EventsBus;
  let url: string;
  let organizationId = ORG;

  beforeEach(async () => {
    const moduleRef = await Test.createTestingModule({
      controllers: [EventsController],
      // The session re-check fires once a minute, far outside any test here.
      providers: [EventsBus, { provide: AuthService, useValue: { assertSessionLive: async () => {} } }],
    })
      .overrideGuard(TenantGuard)
      .useValue({
        canActivate: (ctx: { switchToHttp: () => { getRequest: () => { tenant: unknown } } }) => {
          ctx.switchToHttp().getRequest().tenant = { organizationId, apiKeyId: null, scopes: [], userId: 'u1', sessionId: 's1' };
          return true;
        },
      })
      .compile();

    app = moduleRef.createNestApplication();
    bus = app.get(EventsBus);
    await app.listen(0);
    const port = (app.getHttpServer().address() as { port: number }).port;
    url = `http://127.0.0.1:${port}/api/v1/events`;
  });

  afterEach(async () => {
    organizationId = ORG;
    await app.close();
  });

  it('opens with an event-stream content type', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });

    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('text/event-stream');
    // Without this a buffering proxy holds every event until the stream closes,
    // which turns a working stream into a hang that only reproduces in prod.
    expect(res.headers.get('x-accel-buffering')).toBe('no');

    controller.abort();
  });

  it('announces itself before anything happens, so quiet is distinguishable from broken', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });

    for await (const frame of frames(res.body!)) {
      expect(frame.type).toBe('ready');
      break;
    }

    controller.abort();
  });

  it('delivers an event published after the client connected', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const stream = frames(res.body!);

    // Consume `ready` first: it proves the subscription is live, which is what
    // makes the publish below a fair test rather than a race.
    const ready = await stream.next();
    expect(ready.value?.type).toBe('ready');

    bus.publish({ organizationId: ORG, type: 'lead.created', leadSourceId: 'src-1' });

    const received = await stream.next();
    expect(received.value).toMatchObject({
      organizationId: ORG,
      type: 'lead.created',
      leadSourceId: 'src-1',
    });

    controller.abort();
  });

  it('never delivers another tenant\'s events', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const stream = frames(res.body!);

    expect((await stream.next()).value?.type).toBe('ready');

    // The one that must not arrive, published first so that if the filter leaks
    // it wins the race and the assertion below fails loudly.
    bus.publish({ organizationId: OTHER_ORG, type: 'lead.created', leadSourceId: 'theirs' });
    bus.publish({ organizationId: ORG, type: 'delivery.received', leadSourceId: 'mine' });

    const received = await stream.next();
    expect(received.value?.organizationId).toBe(ORG);
    expect(received.value?.leadSourceId).toBe('mine');

    controller.abort();
  });

  it('streams incrementally rather than buffering until close', async () => {
    const controller = new AbortController();
    const res = await fetch(url, { signal: controller.signal });
    const stream = frames(res.body!);

    await stream.next(); // ready

    // Three publishes spaced in time. If the response were buffered, none of
    // these would be readable while the connection is still open — the awaits
    // below would hang and the test would time out.
    for (const id of ['a', 'b', 'c']) {
      bus.publish({ organizationId: ORG, type: 'delivery.received', leadSourceId: id });
      const got = await stream.next();
      expect(got.value?.leadSourceId).toBe(id);
    }

    controller.abort();
  });
});
