import { useCallback, useEffect, useRef, useState } from 'react';
import Nango, { type ConnectUI, type ConnectUIEvent } from '@nangohq/frontend';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type ConnectSession, type IntegrationConnection } from '../../../utils/integrationsApi';

export type ConnectOutcome =
  | { kind: 'connected'; connection: IntegrationConnection }
  /** Nango reported success, but our server has not confirmed it yet (the webhook will). */
  | { kind: 'pending'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'failed'; message: string };

/**
 * Runs Nango's Connect UI for a new account (`connect`) or to repair one
 * (`reconnect`). Only one runs at a time: a second click while one is open is
 * ignored, so a double click never opens two windows or links twice.
 *
 * Success is only reported after the backend confirms the connection with
 * Nango (POST /integrations/connections/confirm). Nothing is "connected" on
 * the strength of the browser's word.
 */
export function useNangoConnect() {
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const busyRef = useRef(false);
  const uiRef = useRef<ConnectUI | null>(null);

  // Leaving the page closes an open Connect window.
  useEffect(() => () => uiRef.current?.close(), []);

  const run = useCallback(async (key: string, start: () => Promise<ConnectSession>): Promise<ConnectOutcome> => {
    if (busyRef.current) return { kind: 'cancelled' };
    busyRef.current = true;
    setBusyKey(key);
    try {
      let session: ConnectSession;
      try {
        session = await start();
      } catch (error) {
        return { kind: 'failed', message: messageFor(error) };
      }
      return await new Promise<ConnectOutcome>((resolve) => {
        let settled = false;
        let lastError: string | null = null;
        const finish = (outcome: ConnectOutcome) => {
          if (settled) return;
          settled = true;
          resolve(outcome);
        };

        const onEvent = async (event: ConnectUIEvent) => {
          switch (event.type) {
            case 'connect': {
              const { providerConfigKey, connectionId, isPending } = event.payload;
              if (isPending) {
                finish({ kind: 'pending', message: 'Almost done — the account will appear here once the provider finishes.' });
                return;
              }
              try {
                const connection = await integrationsApi.confirm(providerConfigKey, connectionId);
                finish({ kind: 'connected', connection });
              } catch (error) {
                finish({
                  kind: 'pending',
                  message: `Authorized, but EstatePulse could not confirm it yet (${messageFor(error)}). It will appear here once confirmed.`,
                });
              }
              return;
            }
            case 'error':
              // Connect UI shows the error itself and lets the person retry; remember it for when they close.
              lastError = event.payload.errorMessage || 'The provider did not complete the authorization.';
              return;
            case 'close':
              uiRef.current = null;
              finish(lastError ? { kind: 'failed', message: lastError } : { kind: 'cancelled' });
              return;
            default:
              return;
          }
        };

        const nango = new Nango({ connectSessionToken: session.sessionToken, ...(session.apiURL ? { host: session.apiURL } : {}) });
        uiRef.current = nango.openConnectUI({
          sessionToken: session.sessionToken,
          ...(session.apiURL ? { apiURL: session.apiURL } : {}),
          ...(session.baseURL ? { baseURL: session.baseURL } : {}),
          // A closed OAuth popup counts as a failed attempt instead of a window that waits forever.
          detectClosedAuthWindow: true,
          onEvent,
        });
      });
    } finally {
      busyRef.current = false;
      setBusyKey(null);
    }
  }, []);

  const connect = useCallback((providerId: string) => run(`connect:${providerId}`, () => integrationsApi.connect(providerId)), [run]);
  const reconnect = useCallback(
    (connectionId: string) => run(`reconnect:${connectionId}`, () => integrationsApi.reconnect(connectionId)),
    [run],
  );

  return { connect, reconnect, busyKey, busy: busyKey !== null };
}
