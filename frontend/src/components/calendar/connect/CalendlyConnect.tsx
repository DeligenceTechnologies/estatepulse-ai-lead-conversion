import React, { useEffect, useRef, useState } from 'react';
import { Link2, Loader2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { connectCalendly } from '../../../utils/calendarApi';
import { Button } from '../../common/Button';

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
      if (!(await connectCalendly(ac.signal))) return;
      const connected = await onConnected();
      if (!connected && !ac.signal.aborted) toast.error('Calendly was not connected.');
    } catch (e) {
      if (!ac.signal.aborted) toast.error(messageFor(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      <ol className="space-y-1 text-xs text-slate-400 list-decimal list-inside">
        <li>Sign in with the Calendly account that owns or administers your organization.</li>
        <li>Approve access in the window that opens.</li>
      </ol>
      <Button
        onClick={() => void connect()}
        icon={busy ? <Loader2 className="animate-spin" /> : <Link2 />}
      >
        {busy ? 'Waiting for Calendly… (cancel)' : reconnect ? 'Reconnect Calendly' : 'Connect with Calendly'}
      </Button>
    </div>
  );
};
