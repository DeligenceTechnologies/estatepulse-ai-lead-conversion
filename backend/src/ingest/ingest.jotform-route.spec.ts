import { Module, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { ProcessingWorker } from './processing/worker.service';

/**
 * The Jotform route over real HTTP: Jotform posts multipart form fields, which
 * the app's global body parsers ignore. This checks the route reads them and
 * hands IngestService the JSON it stores.
 */

const receive = vi.fn().mockResolvedValue({ kind: 'accepted', eventId: 'evt-1' });

@Module({
  controllers: [IngestController],
  providers: [
    { provide: IngestService, useValue: { receive } },
    { provide: ProcessingWorker, useValue: { nudge: vi.fn() } },
    { provide: ConfigService, useValue: { get: vi.fn() } },
  ],
})
class TestModule {}

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create<NestExpressApplication>(TestModule, { rawBody: true, logger: false });
  await app.listen(0);
  base = await app.getUrl();
});
afterAll(() => app.close());

const rawRequest = { q3_fullName: { first: 'Asha', last: 'Verma' }, q4_email: 'asha@example.test', slug: 'submit/1/' };

describe('POST ingest/v1/jotform/:token', () => {
  it('reads a multipart submission into the stored JSON', async () => {
    receive.mockClear();
    const form = new FormData();
    form.set('submissionID', '5912345678901234567');
    form.set('formID', '231234567890');
    form.set('formTitle', 'Buyer enquiry');
    form.set('pretty', 'Name:Asha Verma, Email:asha@example.test');
    form.set('rawRequest', JSON.stringify(rawRequest));

    const res = await fetch(`${base}/ingest/v1/jotform/whk_live_TOKEN`, { method: 'POST', body: form });
    expect(res.status).toBe(202);
    const call = receive.mock.calls[0][0];
    expect(call).toMatchObject({ route: 'JOTFORM', token: 'whk_live_TOKEN', signature: undefined });
    expect(JSON.parse(call.rawBody.toString('utf8'))).toEqual({
      submissionID: '5912345678901234567',
      formID: '231234567890',
      formTitle: 'Buyer enquiry',
      rawRequest,
    });
  });

  it('reads the same fields posted urlencoded', async () => {
    receive.mockClear();
    const res = await fetch(`${base}/ingest/v1/jotform/whk_live_TOKEN`, {
      method: 'POST',
      body: new URLSearchParams({ submissionID: '77', formID: '1', formTitle: 'T', rawRequest: JSON.stringify(rawRequest) }),
    });
    expect(res.status).toBe(202);
    expect(JSON.parse(receive.mock.calls[0][0].rawBody.toString('utf8'))).toMatchObject({ submissionID: '77', rawRequest });
  });

  it('refuses an empty post without calling the service', async () => {
    receive.mockClear();
    const res = await fetch(`${base}/ingest/v1/jotform/whk_live_TOKEN`, { method: 'POST', body: new FormData() });
    expect(res.status).toBe(400);
    expect(receive).not.toHaveBeenCalled();
  });
});
