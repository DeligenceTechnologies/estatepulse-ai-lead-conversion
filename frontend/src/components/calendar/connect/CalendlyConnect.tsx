import React, { useEffect, useRef, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { openCalendlyPopup, startCalendlyConnect } from '../../../utils/calendarApi';
import { PROVIDERS, PrimaryButton } from '../shared/ui';

export const CalendlyConnect: React.FC<{ onConnected: () => Promise<boolean>; reconnect?: boolean }> = ({
  onConnected,
  reconnect,
}) => {
  const [busy, setBusy] = useState(false);
  const pending = useRef<AbortController | null>(null);

  useEffect(() => () => pending.current?.abort(), []);

  const connect = async () => {
    if (busy) {
      pending.current?.abort();
      return;
    }
    setBusy(true);
    const ac = new AbortController();
    pending.current = ac;
    try {
      const { authorizeUrl } = await startCalendlyConnect();
      const result = await openCalendlyPopup(authorizeUrl, ac.signal);
      const connected = await onConnected();
      if (!connected && !ac.signal.aborted) {
        toast.error(
          result.outcome === 'failed'
            ? (result.message ?? 'Calendly was not connected.')
            : 'The Calendly window was closed before the connection finished.',
        );
      }
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <ol className="space-y-1 text-xs text-slate-400 list-decimal list-inside">
        <li>Sign in with the Calendly account that owns or administers your organization.</li>
        <li>Approve access. The window closes on its own when it is done.</li>
      </ol>
      <PrimaryButton
        onClick={() => void connect()}
        className={PROVIDERS.calendly.button}
        icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Link2 className="w-3.5 h-3.5" />}
      >
        {busy ? 'Waiting for Calendly… (cancel)' : reconnect ? 'Reconnect Calendly' : 'Connect with Calendly'}
      </PrimaryButton>
    </div>
  );
};
