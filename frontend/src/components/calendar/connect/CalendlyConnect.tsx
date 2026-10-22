import React, { useState } from 'react';
import { Link2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { openCalendlyPopup, startCalendlyConnect } from '../../../utils/calendarApi';
import { PROVIDERS, PrimaryButton } from '../shared/ui';

export const CalendlyConnect: React.FC<{ onConnected: () => Promise<boolean>; reconnect?: boolean }> = ({
  onConnected,
  reconnect,
}) => {
  const [busy, setBusy] = useState(false);

  const connect = async () => {
    setBusy(true);
    try {
      const { authorizeUrl } = await startCalendlyConnect();
      const result = await openCalendlyPopup(authorizeUrl);
      const connected = await onConnected();
      if (!connected) {
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
        busy={busy}
        className={PROVIDERS.calendly.button}
        icon={<Link2 className="w-3.5 h-3.5" />}
      >
        {busy ? 'Waiting for Calendly…' : reconnect ? 'Reconnect Calendly' : 'Connect with Calendly'}
      </PrimaryButton>
    </div>
  );
};
