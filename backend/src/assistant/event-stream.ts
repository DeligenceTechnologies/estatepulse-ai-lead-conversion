import type { Response } from 'express';
import type { AssistantEvent } from './assistant-orchestrator.service';

/**
 * Server-sent events over a POST response, read by the app with fetch.
 *
 * The stream only carries events; it does not own the turn. If the browser goes away (a reload, a
 * closed tab, a dropped network), writing stops but the turn carries on and is saved, so the chat
 * shows the full answer when it is opened again. Stopping a turn on purpose is its own request.
 */
export class EventStream {
  private started = false;
  private closed = false;

  constructor(private readonly res: Response) {
    res.on('close', () => {
      if (!res.writableFinished) this.closed = true;
    });
  }

  get isOpen(): boolean {
    return this.started;
  }

  /** False once the browser has gone away. */
  get connected(): boolean {
    return !this.closed;
  }

  send = (event: AssistantEvent): void => {
    if (this.closed) return;
    if (!this.started) this.start();
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  end(): void {
    if (this.closed) return;
    if (!this.started) this.start();
    this.res.end();
  }

  private start(): void {
    this.started = true;
    this.res.status(200);
    this.res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
    this.res.setHeader('Cache-Control', 'no-cache, no-transform');
    this.res.setHeader('X-Accel-Buffering', 'no');
    this.res.flushHeaders();
  }
}
