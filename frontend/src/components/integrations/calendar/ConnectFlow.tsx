import React, { useState } from 'react';
import { Check, CheckCircle2, RotateCcw, ShieldAlert } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import {
  activateCalendar,
  type CalendarConnection,
  type CalendarProviderId,
  type OrganizationCalendarStatus,
} from '../../../utils/calendarApi';
import { CalComConnect } from './CalComConnect';
import { CalendlyConnect } from './CalendlyConnect';
import { Notice, PROVIDER_IDS, PROVIDERS, PrimaryButton, ProviderBadge, WORKSPACE_LABEL, panel } from './ui';

const describe = (connection: CalendarConnection): string =>
  [connection.accountEmail ?? connection.accountName, connection.workspaceName ?? WORKSPACE_LABEL[connection.workspaceType]]
    .filter(Boolean)
    .join(' · ');

const AccountLine: React.FC<{ connection: CalendarConnection }> = ({ connection }) => (
  <div className="flex items-center gap-2 min-w-0 text-xs">
    <CheckCircle2 className="w-4 h-4 text-emerald-400 shrink-0" />
    <span className="text-slate-200 truncate">{describe(connection)}</span>
  </div>
);

const SavedAccount: React.FC<{
  provider: CalendarProviderId;
  connection: CalendarConnection;
  onConnected: () => Promise<boolean>;
  onConnectAnother: () => void;
}> = ({ provider, connection, onConnected, onConnectAnother }) => {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { label, button } = PROVIDERS[provider];

  const use = async () => {
    setBusy(true);
    setError(null);
    try {
      await activateCalendar(provider);
      await onConnected();
    } catch (e) {
      setError(messageFor(e));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-3">
      {error && <Notice tone="error">{error}</Notice>}
      <div>
        <p className="text-xs text-slate-400 mb-1.5">This organization connected {label} before:</p>
        <AccountLine connection={connection} />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        <PrimaryButton onClick={() => void use()} busy={busy} className={button} icon={<Check className="w-3.5 h-3.5" />}>
          Use this {label} account
        </PrimaryButton>
        <button
          type="button"
          onClick={onConnectAnother}
          disabled={busy}
          className="text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer disabled:opacity-50"
        >
          Connect a different account
        </button>
      </div>
    </div>
  );
};

export const ConnectFlow: React.FC<{
  status: OrganizationCalendarStatus;
  initial: CalendarProviderId;
  onConnected: () => Promise<boolean>;
  onCancel?: () => void;
}> = ({ status, initial, onConnected, onCancel }) => {
  const [choice, setChoice] = useState<CalendarProviderId>(initial);
  const [connectNew, setConnectNew] = useState<Partial<Record<CalendarProviderId, boolean>>>({});
  const option = status.providers.find((provider) => provider.id === choice);
  const current = status.provider;
  const saved = option?.saved ?? null;

  let panelBody: React.ReactNode;
  if (choice === current && status.connection) {
    panelBody = (
      <div className="space-y-3">
        <div>
          <p className="text-xs text-slate-400 mb-1.5">{PROVIDERS[choice].label} is already your calendar:</p>
          <AccountLine connection={status.connection} />
        </div>
        {onCancel && (
          <PrimaryButton
            onClick={onCancel}
            className={PROVIDERS[choice].button}
            icon={<Check className="w-3.5 h-3.5" />}
          >
            Keep {PROVIDERS[choice].label}
          </PrimaryButton>
        )}
      </div>
    );
  } else if (option && !option.canConnect) {
    panelBody = (
      <div className="flex items-start gap-2 text-xs text-slate-400 leading-relaxed">
        <ShieldAlert className="w-4 h-4 text-amber-400 shrink-0" />
        {option.reason ?? `${PROVIDERS[choice].label} is not available right now.`}
      </div>
    );
  } else if (saved && saved.status === 'active' && !connectNew[choice]) {
    panelBody = (
      <SavedAccount
        key={choice}
        provider={choice}
        connection={saved}
        onConnected={onConnected}
        onConnectAnother={() => setConnectNew((value) => ({ ...value, [choice]: true }))}
      />
    );
  } else {
    const form =
      choice === 'calendly' ? (
        <CalendlyConnect key="calendly" onConnected={onConnected} reconnect={Boolean(saved)} />
      ) : (
        <CalComConnect key="cal" onConnected={onConnected} reconnect={Boolean(saved)} />
      );
    panelBody = (
      <div className="space-y-3">
        {saved?.status === 'error' && (
          <Notice tone="warning">
            {saved.lastError ?? `The saved ${PROVIDERS[choice].label} connection stopped working.`}
          </Notice>
        )}
        {saved?.status === 'active' && connectNew[choice] && (
          <button
            type="button"
            onClick={() => setConnectNew((value) => ({ ...value, [choice]: false }))}
            className="inline-flex items-center gap-1.5 text-2xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
          >
            <RotateCcw className="w-3 h-3" />
            Use the saved account instead
          </button>
        )}
        {form}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div role="radiogroup" aria-label="Calendar provider" className="grid gap-2 sm:grid-cols-2">
        {PROVIDER_IDS.map((id) => {
          const selected = id === choice;
          const provider = status.providers.find((entry) => entry.id === id);
          const available = provider?.canConnect ?? false;
          const tag =
            current === id
              ? { text: 'Current', className: 'text-emerald-400' }
              : provider?.saved
                ? { text: 'Saved', className: 'text-slate-400' }
                : !available
                  ? { text: 'Unavailable', className: 'text-amber-400' }
                  : null;
          return (
            <button
              key={id}
              type="button"
              role="radio"
              aria-checked={selected}
              onClick={() => setChoice(id)}
              className={`text-left rounded-xl border p-3 flex items-start gap-3 transition-colors cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
                selected ? PROVIDERS[id].selected : 'border-slate-800 bg-slate-950/40 hover:border-slate-700'
              }`}
            >
              <ProviderBadge id={id} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                  <span className="text-xs font-bold text-white">{PROVIDERS[id].label}</span>
                  {tag && <span className={`text-2xs font-semibold ${tag.className}`}>{tag.text}</span>}
                </span>
                <span className="block text-2xs text-slate-400 mt-0.5 leading-relaxed">{PROVIDERS[id].tagline}</span>
              </span>
              <span
                aria-hidden
                className={`w-4 h-4 rounded-full border flex items-center justify-center shrink-0 mt-0.5 ${
                  selected ? 'border-emerald-400 bg-emerald-500' : 'border-slate-600'
                }`}
              >
                {selected && <Check className="w-2.5 h-2.5 text-slate-950" />}
              </span>
            </button>
          );
        })}
      </div>

      {current && current !== choice && (
        <Notice tone="info">
          Switching to {PROVIDERS[choice].label} makes it your calendar. {PROVIDERS[current].label} stays saved, so you
          can switch back without connecting again.
        </Notice>
      )}

      <div className={`${panel} p-4`}>{panelBody}</div>

      {onCancel && (
        <button
          type="button"
          onClick={onCancel}
          className="text-xs font-semibold text-slate-400 hover:text-slate-200 cursor-pointer"
        >
          Cancel
        </button>
      )}
    </div>
  );
};
