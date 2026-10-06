import { useEffect, useRef, useState } from 'react';
import { endSessionIfUnauthenticated, getToken } from './api';

/**
 * The push side of the live screens: a stream that says "something changed",
 * so nothing has to ask every few seconds whether it did.
 *
 * Read with `fetch` rather than `EventSource`, deliberately. `EventSource`
 * cannot set request headers, so authenticating it means putting the session
 * token in the query string — and query strings are written to access logs,
 * proxy logs, and browser history. Reading the stream with `fetch` lets the
 * `Authorization: Bearer` header work exactly as it does on every other call,
 * so the backend route needs no second authentication scheme and no ticket
 * endpoint. The cost is that reconnection is ours to implement, which the loop
 * below does with backoff.
 *
 * An event carries no data worth trusting: it is a nudge to refetch through the
 * ordinary guarded endpoints. Treat it as "go look", never as a source of truth.
 */

const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

export type LiveEventType = 'delivery.received' | 'lead.created' | 'lead.assigned';

export interface LiveEvent {
  type: LiveEventType;
  leadSourceId: string | null;
  at: string;
}

/** Frames the transport sends that are not domain events. */
type ControlFrame = { type: 'ready' | 'ping'; at: string };

const RECONNECT_BASE_MS = 1_000;
const RECONNECT_MAX_MS = 30_000;

/**
 * One SSE frame: `data:` lines, a blank line, repeat. Lines beginning with `:`
 * are comments and carry nothing.
 */
function parseFrame(frame: string): unknown | null {
  const data = frame
    .split('\n')
    .filter((line) => line.startsWith('data:'))
    .map((line) => line.slice(5).trimStart())
    .join('\n');
  if (!data) return null;
  try {
    return JSON.parse(data);
  } catch {
    // A frame we cannot read is not worth tearing the connection down for.
    return null;
  }
}

/**
 * Consume the stream until it ends or is aborted.
 *
 * Resolves on a clean end (the server closed, a proxy reaped an idle
 * connection); throws on anything else, which the caller turns into a retry.
 *
 * Exported for the session tests: useLiveEvents would need a React renderer and
 * a fake timer for the backoff loop to reach the same two lines.
 */
export async function pump(
  signal: AbortSignal,
  onEvent: (e: LiveEvent) => void,
  onOpen: () => void,
): Promise<void> {
  const token = getToken();
  if (!token) throw new Error('not signed in');

  const res = await fetch(`${BASE}/v1/events`, {
    headers: { Authorization: `Bearer ${token}`, Accept: 'text/event-stream' },
    signal,
  });

  // 401/403 both stop the retry loop: retrying either on a timer forever is
  // pure noise, and the poll will surface the real error. Only the 401 ends the
  // session though — a 403 is a permission error on a token that is still good.
  if (res.status === 401 || res.status === 403) {
    endSessionIfUnauthenticated(res.status);
    throw Object.assign(new Error('session rejected'), { fatal: true });
  }
  if (!res.ok || !res.body) throw new Error(`stream failed (${res.status})`);

  onOpen();

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  for (;;) {
    const { done, value } = await reader.read();
    if (done) return;

    // `stream: true` matters: a multi-byte character can straddle two chunks,
    // and decoding them independently produces replacement characters.
    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');

    // Frames are separated by a blank line. A chunk may contain several, or
    // half of one — hence the buffer.
    let split = buffer.indexOf('\n\n');
    while (split !== -1) {
      const parsed = parseFrame(buffer.slice(0, split));
      buffer = buffer.slice(split + 2);

      const frame = parsed as LiveEvent | ControlFrame | null;
      if (frame && frame.type !== 'ping' && frame.type !== 'ready') {
        onEvent(frame as LiveEvent);
      }
      split = buffer.indexOf('\n\n');
    }
  }
}

export interface LiveEventsState {
  /** True while the stream is open. The UI uses it to explain what it is showing. */
  connected: boolean;
}

/**
 * Subscribe for as long as the component is mounted.
 *
 * `onEvent` is read through a ref, so a caller passing an inline arrow does not
 * tear the connection down and rebuild it on every render.
 */
export function useLiveEvents(
  onEvent: (e: LiveEvent) => void,
  enabled = true,
): LiveEventsState {
  const [connected, setConnected] = useState(false);
  const handler = useRef(onEvent);
  handler.current = onEvent;

  useEffect(() => {
    if (!enabled) return;

    let stopped = false;
    let attempt = 0;
    let retry: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const loop = async () => {
      while (!stopped) {
        try {
          await pump(controller.signal, (e) => handler.current(e), () => {
            attempt = 0;
            setConnected(true);
          });
          // Clean end — usually a proxy reaping an idle connection. Reconnect
          // promptly, since this is the expected steady-state ending.
          if (stopped) return;
          setConnected(false);
        } catch (err) {
          if (stopped || controller.signal.aborted) return;
          setConnected(false);
          if ((err as { fatal?: boolean }).fatal) return;
        }

        // Exponential backoff with jitter. The jitter is not decoration: without
        // it, every open tab reconnects on the same schedule after a deploy and
        // they arrive as one thundering herd.
        const wait = Math.min(RECONNECT_BASE_MS * 2 ** attempt, RECONNECT_MAX_MS);
        attempt += 1;
        await new Promise<void>((resolve) => {
          retry = setTimeout(resolve, wait * (0.5 + Math.random() * 0.5));
        });
      }
    };

    void loop();

    return () => {
      stopped = true;
      if (retry) clearTimeout(retry);
      controller.abort();
      setConnected(false);
    };
  }, [enabled]);

  return { connected };
}
