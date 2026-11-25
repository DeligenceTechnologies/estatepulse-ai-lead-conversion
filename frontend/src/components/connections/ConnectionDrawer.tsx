import React, { useEffect, useId, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Loader2, Plus, RefreshCw, ShieldCheck, Trash2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { ApiError, messageFor } from '../../lib/api';
import { disconnectConnection, type ConnectionView, type ProviderView } from '../../utils/connectionsApi';
import { Button, IconButton } from '../common/Button';
import { EmbeddedCardContext } from '../integrations/IntegrationCard';
import { BrandMark, StatusBadge, tileState, type TileState } from './ConnectionTile';
import { SetupPanel, type TileKey } from './providerMeta';

const STATE_TEXT: Record<ConnectionView['state'], string> = {
  connected: 'Working',
  needs_setup: 'Waiting for setup below',
  broken: 'Sign-in expired or revoked',
};

const when = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : null);

/**
 * One account in the drawer: who it is, how it signs in, when it was last
 * checked, and Reconnect / Disconnect. Disconnect asks once on the row itself;
 * a second answer from the server ("forms still use it") asks again with force.
 */
const AccountRow: React.FC<{
  connection: ConnectionView;
  auth: ProviderView['auth'];
  canEdit: boolean;
  busy: boolean;
  onReconnect: () => void;
  onDisconnected: () => void;
}> = ({ connection: c, auth, canEdit, busy, onReconnect, onDisconnected }) => {
  const [confirm, setConfirm] = useState<null | 'ask' | { force: string }>(null);
  const [working, setWorking] = useState(false);

  const disconnect = async (force: boolean) => {
    setWorking(true);
    try {
      await disconnectConnection(c.id, force);
      toast.success('Disconnected. Leads already imported are kept.');
      onDisconnected();
    } catch (e) {
      if (e instanceof ApiError && e.status === 409 && !force) setConfirm({ force: e.message });
      else toast.error(messageFor(e));
    } finally {
      setWorking(false);
    }
  };

  const who = c.accountEmail || c.accountName || c.label || 'Connected account';
  const verified = when(c.lastVerifiedAt);

  return (
    <li
      className={`rounded-xl border p-3.5 bg-slate-950/60 ${c.state === 'broken' ? 'border-rose-500/30' : 'border-slate-800'}`}
    >
      <div className="flex items-start gap-3">
        <span
          className={`mt-0.5 w-8 h-8 rounded-lg flex items-center justify-center shrink-0 border ${
            c.state === 'broken'
              ? 'bg-rose-500/10 border-rose-500/25 text-rose-300'
              : 'bg-emerald-500/10 border-emerald-500/20 text-emerald-300'
          }`}
        >
          {c.state === 'broken' ? <AlertTriangle className="w-4 h-4" /> : auth === 'apiKey' ? <KeyRound className="w-4 h-4" /> : <ShieldCheck className="w-4 h-4" />}
        </span>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-white truncate">{who}</div>
          <div className="text-2xs text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
            <span className={c.state === 'broken' ? 'text-rose-300' : c.state === 'needs_setup' ? 'text-amber-300' : ''}>{STATE_TEXT[c.state]}</span>
            {c.preview && c.preview !== 'oauth' && <span className="font-mono">{c.preview}</span>}
            {verified && <span>· checked {verified}</span>}
          </div>
        </div>
        {canEdit && confirm === null && (
          <div className="flex items-center gap-1.5 shrink-0">
            {c.state === 'broken' && (
              <Button size="sm" variant="danger" icon={<RefreshCw className="w-3.5 h-3.5" />} disabled={busy} onClick={onReconnect}>
                Reconnect
              </Button>
            )}
            <IconButton aria-label={`Disconnect ${who}`} icon={<Trash2 />} disabled={busy || working} onClick={() => setConfirm('ask')} />
          </div>
        )}
      </div>

      {confirm !== null && (
        <div className="mt-3 rounded-lg border border-rose-500/25 bg-rose-500/5 p-3 text-xs text-rose-100 space-y-2.5">
          <p className="leading-relaxed">
            {confirm === 'ask'
              ? 'Disconnect this account? We stop using it and delete its credential. Leads already imported stay.'
              : `${confirm.force} Disconnect anyway?`}
          </p>
          <div className="flex gap-2">
            <Button size="sm" variant="danger" disabled={working} icon={working ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : undefined} onClick={() => void disconnect(confirm !== 'ask')}>
              Disconnect
            </Button>
            <Button size="sm" variant="ghost" disabled={working} onClick={() => setConfirm(null)}>
              Cancel
            </Button>
          </div>
        </div>
      )}
    </li>
  );
};

/**
 * A provider's drawer: its accounts at the top (connect another, reconnect,
 * disconnect — the same for every provider), then that provider's own setup.
 */
export const ConnectionDrawer: React.FC<{
  tile: TileKey;
  provider: ProviderView | null;
  label: string;
  description: string;
  canEdit: boolean;
  busy: boolean;
  onConnect: () => void;
  onReconnect: (id: string) => void;
  onChanged: () => void;
  onClose: () => void;
}> = ({ tile, provider, label, description, canEdit, busy, onConnect, onReconnect, onChanged, onClose }) => {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = overflow;
      opener?.focus?.();
    };
  }, [onClose]);

  const connections = provider?.connections ?? [];
  const state: TileState = provider ? tileState(connections, provider.unavailable) : 'connected';
  const canAdd = provider && !provider.unavailable && (provider.multiple || connections.length === 0);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-scrim backdrop-blur-sm animate-fade-in" onClick={onClose} />

      <aside className="relative w-full sm:max-w-2xl h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col animate-slide-in-right text-slate-100">
        <header className="relative overflow-hidden px-6 pt-6 pb-5 border-b border-slate-800">
          <div aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-24 bg-gradient-to-b from-indigo-500/10 to-transparent" />
          <div className="relative flex items-start gap-4">
            <BrandMark tile={tile} size="lg" />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2">
                <h3 id={titleId} className="text-lg font-bold text-white tracking-tight">
                  {label}
                </h3>
                {provider && <StatusBadge state={state} />}
              </div>
              <p className="text-xs text-slate-400 mt-1 leading-relaxed">{description}</p>
            </div>
            <IconButton ref={closeButton} onClick={onClose} aria-label="Close" icon={<X />} />
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar px-6 py-5 space-y-8">
          {provider && (
            <section className="space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">
                    {provider.multiple ? 'Accounts' : 'Account'}
                  </h4>
                  <p className="text-2xs text-slate-500 mt-0.5">
                    {provider.auth === 'apiKey'
                      ? 'Your API key is stored encrypted by our credential vault and never shown again.'
                      : 'Signed in with the provider. We never see your password.'}
                  </p>
                </div>
                {canEdit && canAdd && (
                  <Button size="sm" icon={busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} disabled={busy} onClick={onConnect}>
                    {connections.length ? 'Add account' : `Connect ${label}`}
                  </Button>
                )}
              </div>

              {provider.unavailable && connections.length === 0 ? (
                <div className="rounded-xl border border-slate-800 bg-slate-950/60 p-4 text-xs text-slate-400">{provider.unavailable}</div>
              ) : connections.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-700 bg-slate-950/40 p-5 text-center text-xs text-slate-400">
                  Nothing connected yet. Connect {label} to start.
                </div>
              ) : (
                <ul className="space-y-2">
                  {connections.map((c) => (
                    <AccountRow
                      key={c.id}
                      connection={c}
                      auth={provider.auth}
                      canEdit={canEdit}
                      busy={busy}
                      onReconnect={() => onReconnect(c.id)}
                      onDisconnected={onChanged}
                    />
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* The provider's own setup: only once an account is there (the webhook needs none). */}
          {(!provider || connections.length > 0) && (
            <section className="space-y-3">
              {provider && <h4 className="text-xs font-bold uppercase tracking-wider text-slate-400">Setup</h4>}
              <EmbeddedCardContext.Provider value={true}>
                <SetupPanel tile={tile} />
              </EmbeddedCardContext.Provider>
            </section>
          )}
        </div>
      </aside>
    </div>
  );
};
