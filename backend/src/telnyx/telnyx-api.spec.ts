import { afterEach, describe, expect, it, vi } from 'vitest';
import { telnyx } from './telnyx-api';

const reply = (status: number, body: string) => vi.fn(async () => new Response(status === 204 ? null : body, { status }));

describe('telnyx()', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('reads a JSON answer', async () => {
    vi.stubGlobal('fetch', reply(200, '{"data":{"id":"x"}}'));
    expect(await telnyx('KEY', '/x')).toEqual({ data: { id: 'x' } });
  });

  it('accepts a success with no body, as adding a message to a conversation answers', async () => {
    vi.stubGlobal('fetch', reply(200, ''));
    expect(await telnyx('KEY', '/ai/conversations/c/message', { method: 'POST' })).toEqual({});
    vi.stubGlobal('fetch', reply(204, ''));
    expect(await telnyx('KEY', '/x', { method: 'DELETE' })).toEqual({});
  });

  it('still throws with the provider message on a failure', async () => {
    vi.stubGlobal('fetch', reply(422, 'bad thing'));
    await expect(telnyx('KEY', '/x', { method: 'POST' })).rejects.toThrow('Telnyx POST /x failed 422: bad thing');
  });
});
