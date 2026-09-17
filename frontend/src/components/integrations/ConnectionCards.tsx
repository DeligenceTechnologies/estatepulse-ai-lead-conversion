import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Plus,
  Settings2,
  Webhook,
  X,
} from 'lucide-react';
import {
  ApiError,
  api,
  providersApi,
  type LeadSourceConfig,
  type ProviderConnection,
} from '../../api/client';
import { useApp } from '../../context/AppContext';
import { ConnectModal, type ConnectKind } from '../leadsources/ConnectModal';
import { SourceStatusPill } from '../leadsources/StatusPills';

/**
 * Integrations & Webhooks, in exactly two cards.
 *
 * This screen answers one question — what is connected, and how do I connect
 * another — so it shows connections and nothing else. Everything about what a
 * source has *brought in* (leads, deliveries, mapping detail, signing secrets)
 * lives on Lead Sources, the screen people actually watch. Showing it in both
 * places made a page you visit twice a year look like a dashboard.
 *
 * Both cards read the same endpoint and differ only in how the webhook got onto
 * the form: API means we installed it with a key and can repair it, MANUAL
 * means the customer pasted our URL in themselves and only they can.
 */

const norm = (s: string | null | undefined) => (s ?? '').toUpperCase();

/** Remote states that mean submissions may be going nowhere, silently. */
const BROKEN = ['UNINSTALLED', 'ORPHANED', 'ERROR', 'DRIFTED'];

const CopyButton: React.FC<{ value: string; title: string }> = ({ value, title }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title={title}
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — the URL is still on Lead Sources to select by hand */
        }
      }}
      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
    >
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

/**
 * One connected form. Name, whether it is healthy, and the two controls that
 * are genuinely about the connection — repair and disconnect. Repair only
 * appears when something is actually wrong, so a healthy list stays quiet.
 */
const SourceRow: React.FC<{
  source: LeadSourceConfig;
  busy: boolean;
  confirming: boolean;
  onOpen: (id: string) => void;
  onRepair: (source: LeadSourceConfig, mode: 'resync' | 'reinstall') => void;
  onDisconnect: (source: LeadSourceConfig) => void;
}> = ({ source, busy, confirming, onOpen, onRepair, onDisconnect }) => {
  const broken = BROKEN.includes(norm(source.remoteState));
  const isApi = norm(source.connectionMethod) === 'API';

  return (
    <div
      className={`bg-slate-950 border rounded-xl px-3 py-2.5 ${
        broken ? 'border-rose-500/40' : 'border-slate-800/80'
      }`}
    >
      <div className="flex items-center gap-2">
        <button
          type="button"
          onClick={() => onOpen(source.id)}
          title="See its leads on Lead Sources"
          className="min-w-0 flex-1 text-left group cursor-pointer"
        >
          <div className="text-xs font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">
            {source.externalFormName || source.name}
          </div>
          {source.externalFormName && source.externalFormName !== source.name && (
            <div className="text-[11px] text-slate-500 truncate">{source.name}</div>
          )}
        </button>

        <SourceStatusPill source={source} />

        {/* The webhook URL is the whole point of a manual source — the customer
            pastes it into their form tool, and may need it again on any device. */}
        {!isApi && source.webhookUrl && (
          <CopyButton value={source.webhookUrl} title="Copy webhook URL" />
        )}

        <button
          type="button"
          disabled={busy}
          onClick={() => onDisconnect(source)}
          className={`text-[11px] font-semibold px-2.5 py-1 rounded-lg border transition-colors cursor-pointer disabled:opacity-40 shrink-0 ${
            confirming
              ? 'bg-rose-600 border-rose-500 text-white hover:bg-rose-500'
              : 'border-slate-800 text-slate-400 hover:text-rose-300 hover:border-rose-900/60'
          }`}
        >
          {confirming ? 'Confirm' : 'Disconnect'}
        </button>
      </div>

      {/* A webhook that vanished on the provider's side is silent data loss, so
          it gets a repair control rather than a badge and a shrug. */}
      {broken && (
        <div className="mt-2 pt-2 border-t border-slate-800/80 space-y-2">
          <div className="text-[11px] text-rose-200 leading-relaxed">
            {source.remoteErrorMessage ??
              'The webhook is no longer on the form. Submissions since then were never sent to us.'}
          </div>
          {isApi && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onRepair(source, 'resync')}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40"
              >
                Re-sync
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRepair(source, 'reinstall')}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-white text-[11px] font-semibold transition-colors cursor-pointer disabled:opacity-40"
              >
                Reinstall webhook
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

/** Shared shell so the two cards are the same object with different contents. */
const IntegrationCard: React.FC<{
  icon: React.ReactNode;
  title: string;
  blurb: string;
  connected: boolean;
  accent: string;
  action: { label: string; icon: React.ReactNode; onClick: () => void; className: string };
  children: React.ReactNode;
}> = ({ icon, title, blurb, connected, accent, action, children }) => (
  <div
    className={`bg-slate-900/90 border rounded-2xl p-5 shadow-xl flex flex-col gap-4 ${
      connected ? accent : 'border-slate-800'
    }`}
  >
    <div className="flex items-start justify-between gap-3">
      <div className="flex items-center gap-2.5 min-w-0">
        {icon}
        <div className="min-w-0">
          <h3 className="text-base font-bold text-white">{title}</h3>
          <p className="text-[11px] text-slate-400 truncate">{blurb}</p>
        </div>
      </div>
      <span
        className={`text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border flex items-center gap-1 shrink-0 ${
          connected
            ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
            : 'bg-slate-800 text-slate-400 border-slate-700'
        }`}
      >
        {connected && <Check className="w-3 h-3" />}
        {connected ? 'Connected' : 'Not connected'}
      </span>
    </div>

    <div className="flex-1 space-y-2">{children}</div>

    <button
      type="button"
      onClick={action.onClick}
      className={`w-full px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 transition-colors cursor-pointer ${action.className}`}
    >
      {action.icon}
      {action.label}
    </button>
  </div>
);

export const ConnectionCards: React.FC = () => {
  const { setActiveView, setFocusLeadSourceId } = useApp();

  const [sources, setSources] = useState<LeadSourceConfig[] | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  const [connect, setConnect] = useState<ConnectKind | null>(null);

  const load = useCallback(async () => {
    try {
      setSources(await api.listLeadSources());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSources([]);
    }
    // An account with no form connected yet is still a connection, and the card
    // has to say so or "Connect Tally" reads as "your key didn't save".
    try {
      setConnections(await providersApi.connections());
    } catch {
      setConnections([]);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const openInLeadSources = (id: string) => {
    setFocusLeadSourceId(id);
    setActiveView('lead_sources');
  };

  const repair = async (source: LeadSourceConfig, mode: 'resync' | 'reinstall') => {
    setBusy(true);
    try {
      if (mode === 'resync') {
        const r = await providersApi.resync(source.id);
        setNotice(
          `Re-sync: ${r.remoteState.toLowerCase()}${
            r.removedDuplicates ? `, removed ${r.removedDuplicates} duplicate webhook(s)` : ''
          }.`,
        );
      } else {
        await providersApi.reinstall(source.id);
        setNotice('Webhook reinstalled with the same URL and secret — nothing else to change.');
      }
      await load();
    } catch (e) {
      setNotice(e instanceof ApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  /** First click arms, second click does it — no modal for a reversible archive. */
  const disconnect = async (source: LeadSourceConfig) => {
    if (confirmDisconnect !== source.id) {
      setConfirmDisconnect(source.id);
      return;
    }
    setBusy(true);
    try {
      const r = await providersApi.disconnectForm(source.id);
      setNotice(
        r.warning ??
          (norm(source.connectionMethod) === 'API'
            ? 'Disconnected, and the webhook was removed from your form. Leads already received are untouched.'
            : 'Disconnected. Remove the webhook in your form tool too, or it keeps firing at a dead URL.'),
      );
      setConfirmDisconnect(null);
      await load();
    } catch (e) {
      setNotice(
        e instanceof ApiError
          ? `${e.message} You can remove it in your form tool and disconnect again.`
          : String(e),
      );
    } finally {
      setBusy(false);
    }
  };

  const rowProps = (s: LeadSourceConfig) => ({
    key: s.id,
    source: s,
    busy,
    confirming: confirmDisconnect === s.id,
    onOpen: openInLeadSources,
    onRepair: repair,
    onDisconnect: disconnect,
  });

  const tallySources = (sources ?? []).filter((s) => norm(s.connectionMethod) === 'API');
  const webhookSources = (sources ?? []).filter((s) => norm(s.connectionMethod) !== 'API');

  if (sources === null) {
    return (
      <div className="text-xs text-slate-400 flex items-center gap-2 py-8 justify-center">
        <Loader2 className="w-4 h-4 animate-spin" /> Loading connections…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Can't reach the backend</div>
            {error}
          </div>
        </div>
      )}

      {notice && (
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-amber-200 leading-relaxed flex-1">{notice}</div>
          <button
            type="button"
            onClick={() => setNotice(null)}
            className="p-1 rounded-lg text-amber-300/70 hover:text-amber-100 transition-colors cursor-pointer"
          >
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Tally — we hold the key, so we install and repair the webhook. */}
        <IntegrationCard
          icon={
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
              <Link2 className="w-5 h-5" />
            </div>
          }
          title="Tally"
          blurb="Pick a form — we install the webhook for you"
          connected={tallySources.length > 0 || connections.length > 0}
          accent="border-emerald-500/40"
          action={{
            // An account with no form yet gets its own label: "Connect Tally"
            // next to a Connected badge reads as if the key never saved.
            label:
              tallySources.length > 0
                ? 'Manage / add form'
                : connections.length > 0
                  ? 'Add a form'
                  : 'Connect Tally',
            icon: tallySources.length > 0 ? <Settings2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />,
            onClick: () => setConnect('TALLY'),
            className: 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-md shadow-emerald-950',
          }}
        >
          {tallySources.length > 0 ? (
            tallySources.map((s) => <SourceRow {...rowProps(s)} />)
          ) : connections.length > 0 ? (
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-[11px] text-slate-400 leading-relaxed">
              <strong className="text-slate-200">
                {connections[0].label || connections[0].accountEmail || 'Account'}
              </strong>{' '}
              is connected, but no form is selected yet. Add one and its submissions start creating
              leads.
            </div>
          ) : (
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-[11px] text-slate-400 leading-relaxed">
              Paste your Tally API key once, pick the forms you want, and we install the webhook on
              each of them — nothing to copy by hand.
            </div>
          )}
        </IntegrationCard>

        {/* Webhook — we hold nothing, so the customer installs and repairs it. */}
        <IntegrationCard
          icon={
            <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30 shrink-0">
              <Webhook className="w-5 h-5" />
            </div>
          }
          title="Webhook"
          blurb="A URL and signing secret you paste in yourself"
          connected={webhookSources.length > 0}
          accent="border-amber-500/40"
          action={{
            label: webhookSources.length > 0 ? 'Add webhook' : 'Create a webhook',
            icon: <Plus className="w-4 h-4" />,
            onClick: () => setConnect('WEBHOOK'),
            className: 'bg-slate-800 hover:bg-slate-700 text-slate-100',
          }}
        >
          {webhookSources.length > 0 ? (
            webhookSources.map((s) => <SourceRow {...rowProps(s)} />)
          ) : (
            <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-[11px] text-slate-400 leading-relaxed">
              Works with any form tool — Tally, a website form, Zapier. We hand you a URL and a
              signing secret and hold no credential for your account.
            </div>
          )}
        </IntegrationCard>
      </div>

      {connect && (
        <ConnectModal
          initial={connect}
          onClose={() => setConnect(null)}
          onConnected={() => {
            void load();
          }}
          onOpenSource={(id) => {
            setConnect(null);
            openInLeadSources(id);
          }}
        />
      )}
    </div>
  );
};
