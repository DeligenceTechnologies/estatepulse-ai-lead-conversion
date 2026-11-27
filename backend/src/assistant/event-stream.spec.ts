import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { EventStream } from './event-stream';

function fakeResponse() {
  const res = Object.assign(new EventEmitter(), {
    writableFinished: false,
    status: vi.fn(),
    setHeader: vi.fn(),
    flushHeaders: vi.fn(),
    write: vi.fn(),
    end: vi.fn(),
  });
  return res;
}

describe('EventStream', () => {
  it('writes events as server-sent events', () => {
    const res = fakeResponse();
    const stream = new EventStream(res as any);
    stream.send({ type: 'text', text: 'Hi' });
    expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/event-stream; charset=utf-8');
    expect(res.write).toHaveBeenCalledWith('data: {"type":"text","text":"Hi"}\n\n');
    expect(stream.isOpen).toBe(true);
  });

  it('stops writing when the browser goes away, without failing the turn', () => {
    const res = fakeResponse();
    const stream = new EventStream(res as any);
    stream.send({ type: 'text', text: 'first' });
    res.emit('close');

    expect(stream.connected).toBe(false);
    expect(() => stream.send({ type: 'text', text: 'second' })).not.toThrow();
    stream.end();
    expect(res.write).toHaveBeenCalledOnce();
    expect(res.end).not.toHaveBeenCalled();
  });

  it('does not treat the normal end of the response as the browser leaving', () => {
    const res = fakeResponse();
    const stream = new EventStream(res as any);
    stream.end();
    res.writableFinished = true;
    res.emit('close');
    expect(stream.connected).toBe(true);
  });
});
