import type { Response } from 'express';
import type { AssistantEvent } from './assistant-orchestrator.service';

/** Server-sent events over a POST response, read by the dock with fetch. */
export class EventStream {
  private started = false;
  private readonly controller = new AbortController();

  constructor(private readonly res: Response) {
    res.on('close', () => {
      if (!res.writableFinished) this.controller.abort();
    });
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isOpen(): boolean {
    return this.started;
  }

  send = (event: AssistantEvent): void => {
    if (this.controller.signal.aborted) return;
    if (!this.started) this.start();
    this.res.write(`data: ${JSON.stringify(event)}\n\n`);
  };

  end(): void {
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
