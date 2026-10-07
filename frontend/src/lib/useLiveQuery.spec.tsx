import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useLiveQuery, type LiveQueryOptions, type LiveQueryResult } from './useLiveQuery';

/**
 * The poll's timing, driven by fake timers.
 *
 * There is no DOM library here, and none is needed: the probe renders nothing,
 * so React never touches a real node. A plain EventTarget stands in for
 * `document`, which is all the hook reads (visibilityState and the
 * visibilitychange event), and lets a test hide and show the tab.
 */

const SLOW: LiveQueryOptions = { baseIntervalMs: 60_000, maxIntervalMs: 60_000 };

class FakeDocument extends EventTarget {
  nodeType = 9;
  visibilityState: 'visible' | 'hidden' = 'visible';
}
const doc = new FakeDocument();
const g = globalThis as Record<string, unknown>;
g['IS_REACT_ACT_ENVIRONMENT'] = true;
g['document'] = doc;
g['window'] ??= globalThis;
g['HTMLIFrameElement'] ??= class {}; // read by React's commit phase (focus restore)

let root: Root;
let result: LiveQueryResult<unknown>;
let calls: number[];
let fetcher: ReturnType<typeof vi.fn>;
let t0: number;

/** Seconds since the test started, for every fetch so far. */
const at = () => calls.map((ms) => (ms - t0) / 1000);

const Probe = ({ opts }: { opts?: LiveQueryOptions }) => {
  result = useLiveQuery(fetcher as unknown as () => Promise<unknown>, opts);
  return null;
};

const mount = async (opts?: LiveQueryOptions) => {
  const container = Object.assign(new EventTarget(), {
    nodeType: 1,
    nodeName: 'DIV',
    tagName: 'DIV',
    namespaceURI: 'http://www.w3.org/1999/xhtml',
    ownerDocument: doc,
  });
  root = createRoot(container as unknown as HTMLElement);
  await act(async () => root.render(<Probe opts={opts} />));
};
const rerender = (opts?: LiveQueryOptions) => act(async () => root.render(<Probe opts={opts} />));
const advance = (seconds: number) => act(() => vi.advanceTimersByTimeAsync(seconds * 1000));
const setVisible = (visible: boolean) =>
  act(async () => {
    doc.visibilityState = visible ? 'visible' : 'hidden';
    doc.dispatchEvent(new Event('visibilitychange'));
  });

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  t0 = Date.now();
  calls = [];
  doc.visibilityState = 'visible';
  // Same payload every time unless a test says otherwise: an idle screen.
  fetcher = vi.fn(async () => {
    calls.push(Date.now());
    return { leads: [] };
  });
});

afterEach(async () => {
  await act(async () => root.unmount());
  vi.useRealTimers();
});

describe('useLiveQuery cadence', () => {
  it('default cadence is unchanged: 5 s, backing off to a minute while nothing changes', async () => {
    await mount();
    await advance(200);
    expect(at()).toEqual([0, 5, 15, 35, 75, 135, 195]);
  });

  it('default cadence: invalidate still returns to fast polling (the stream-down fallback)', async () => {
    await mount();
    await advance(100);
    await act(async () => result.invalidate());
    await advance(100);
    expect(at()).toEqual([0, 5, 15, 35, 75, 100, 110, 130, 170]);
  });

  it('slow cadence: one load, then once a minute', async () => {
    await mount(SLOW);
    await advance(200);
    expect(at()).toEqual([0, 60, 120, 180]);
  });

  it('slow cadence stays slow when the data keeps changing', async () => {
    fetcher = vi.fn(async () => {
      calls.push(Date.now());
      return { n: calls.length };
    });
    await mount(SLOW);
    await advance(200);
    expect(at()).toEqual([0, 60, 120, 180]);
  });

  it('slow cadence: invalidate refetches once, immediately, and does not restart 5-second polling', async () => {
    await mount(SLOW);
    await advance(30);
    await act(async () => result.invalidate());
    await advance(170);
    expect(at()).toEqual([0, 30, 90, 150]);
  });

  it('switching to the slow cadence re-times the next poll without refetching or clearing data', async () => {
    await mount();
    await advance(1);
    const before = result.data;
    await rerender(SLOW);
    expect(result.data).toBe(before);
    expect(result.data).not.toBeNull();
    await advance(130);
    // No poll at 5 s; the next one is a minute after the switch.
    expect(at()).toEqual([0, 61, 121]);
  });

  it('stream drops and returns: cadence follows, and there is only ever one timer', async () => {
    await mount(SLOW);
    await advance(10);
    await rerender(); // stream down: fast polling from now
    await advance(40);
    await rerender(SLOW); // back up, then a flap
    await rerender();
    await rerender(SLOW);
    expect(vi.getTimerCount()).toBe(1);
    await advance(130);
    expect(at()).toEqual([0, 15, 25, 45, 110, 170]);
    expect(vi.getTimerCount()).toBe(1);
  });

  it('slow cadence: hidden tab polls nothing; returning refetches once and stays slow', async () => {
    await mount(SLOW);
    await advance(20);
    await setVisible(false);
    await advance(300);
    expect(at()).toEqual([0]);
    await setVisible(true);
    await advance(80);
    expect(at()).toEqual([0, 320, 380]);
  });

  it('a burst of events during a fetch is one request (single-flight), and the cadence stays slow', async () => {
    fetcher = vi.fn(() => {
      calls.push(Date.now());
      return new Promise((resolve) => setTimeout(() => resolve({ leads: [] }), 2000));
    });
    await mount(SLOW);
    await advance(3);
    await act(async () => {
      for (let i = 0; i < 5; i++) result.invalidate();
    });
    await advance(1);
    await act(async () => result.invalidate()); // still in flight: dropped
    await advance(126);
    expect(at()).toEqual([0, 3, 65, 127]);
  });
});
