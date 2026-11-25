import Nango from '@nangohq/frontend';

/** What the backend hands out for one Nango Connect run. Short-lived; never a secret key. */
export interface NangoSession {
  sessionToken: string;
  expiresAt: string;
}

/**
 * Runs Nango Connect for one integration and resolves the connection id Nango
 * assigned, or null when the person closed it without connecting.
 *
 * The Connect UI opens straight away (call this from a click) and receives its
 * session token once `createSession` answers. The session is created by our
 * backend, which tags it with the signed-in organization; the connection id
 * this resolves is only reported back, and the backend checks with Nango that
 * the connection is this organization's before using it.
 */
export function runNangoConnect(createSession: () => Promise<NangoSession>, signal?: AbortSignal): Promise<string | null> {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastError: string | null = null;

    const finish = (settle: () => void) => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      settle();
    };

    const ui = new Nango().openConnectUI({
      detectClosedAuthWindow: true,
      onEvent: (event) => {
        switch (event.type) {
          case 'connect':
            finish(() => resolve(event.payload.connectionId));
            ui.close();
            return;
          case 'error':
            // Connect shows the error itself and lets the person try again; it is only reported if they give up.
            lastError = event.payload.errorMessage || null;
            return;
          case 'close':
            finish(() => (lastError ? reject(new Error(lastError)) : resolve(null)));
            return;
          default:
            return;
        }
      },
    });

    const onAbort = () => {
      ui.close();
      finish(() => reject(new DOMException('Cancelled', 'AbortError')));
    };
    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener('abort', onAbort);

    createSession().then(
      (session) => {
        if (!settled) ui.setSessionToken(session.sessionToken);
      },
      (error: unknown) => {
        ui.close();
        finish(() => reject(error));
      },
    );
  });
}
