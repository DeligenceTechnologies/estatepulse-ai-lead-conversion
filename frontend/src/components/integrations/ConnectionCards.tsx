import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  Copy,
  Link2,
  Loader2,
  Plus,
  Settings2,
} from 'lucide-react';
import { toast } from 'react-toastify';
import {
  ApiError,
  api,
  providersApi,
  type LeadSourceConfig,
  type ProviderConnection,
} from '../../api/client';
import { useApp } from '../../context/AppContext';
import { isCustomSource } from '../../utils/customWebhookApi';
import { CustomWebhookWizard } from '../customwebhook/CustomWebhookWizard';
import { ConnectModal } from '../leadsources/ConnectModal';
import { SourceStatusPill } from '../leadsources/StatusPills';
import { CustomWebhookCard } from './CustomWebhookCard';
import { GoogleSheetsCard } from './GoogleSheetsCard';
import { HubSpotCard } from './HubSpotCard';
import { SchedulingCards } from './SchedulingCards';
import { IntegrationCard } from './IntegrationCard';
import { TelnyxCard } from './TelnyxCard';

/**
 * Integrations & Webhooks: every connection the account has, one card each.
 *
 * This screen answers one question — what is connected, and how do I connect
 * another — so it shows connections and nothing else. Everything about what a
 * source has *brought in* (leads, deliveries, mapping detail, signing secrets)
 * lives on Lead Sources, the screen people actually watch. Showing it in both
 * places made a page you visit twice a year look like a dashboard.
 *
 * Telnyx comes first because it is the one connection the product cannot run
 * without — no Telnyx account, no calls — and it owns its own status, so it is
 * self-loading. The two lead-source cards read the same endpoint as each other
 * and differ only in how the webhook got onto the form: API means we installed
 * it with a key and can repair it, MANUAL means the customer pasted our URL in
 * themselves and only they can.
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
          toast.error('Could not copy — select the URL on Lead Sources instead.');
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
            <div className="text-xs text-slate-500 truncate">{source.name}</div>
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
          className={`text-xs font-semibold px-2.5 py-1 rounded-lg border transition-colors cursor-pointer disabled:opacity-40 shrink-0 ${
            confirming
              ? 'bg-rose-600 border-rose-500 text-on-accent hover:bg-rose-500'
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
          <div className="text-xs text-rose-200 leading-relaxed">
            {source.remoteErrorMessage ??
              'The webhook is no longer on the form. Submissions since then were never sent to us.'}
          </div>
          {isApi && (
            <div className="flex gap-2">
              <button
                type="button"
                disabled={busy}
                onClick={() => onRepair(source, 'resync')}
                className="px-2.5 py-1 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
              >
                Re-sync
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={() => onRepair(source, 'reinstall')}
                className="px-2.5 py-1 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40"
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

export const ConnectionCards: React.FC = () => {
  const { setActiveView, setFocusLeadSourceId } = useApp();

  const [sources, setSources] = useState<LeadSourceConfig[] | null>(null);
  const [connections, setConnections] = useState<ProviderConnection[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [confirmDisconnect, setConfirmDisconnect] = useState<string | null>(null);
  /** The form provider whose connect flow is open ('TALLY', 'TYPEFORM'), or null. */
  const [connect, setConnect] = useState<'TALLY' | 'TYPEFORM' | null>(null);
  /** The webhook wizard: closed, or open on a source (null source = create a new one). */
  const [webhookWizard, setWebhookWizard] = useState<{ sourceId: string | null } | null>(null);

  const load = useCallback(async () => {
    // Both are asked for at once: neither needs the other's answer, and asking
    // for the accounts only after the sources had arrived kept this screen
    // waiting through two round trips in a row. The answers are still applied
    // in the same order. The catch only keeps an early failure from being
    // reported as unhandled while the sources are pending — it is handled below.
    const sourcesRequest = api.listLeadSources();
    const connectionsRequest = providersApi.connections();
    connectionsRequest.catch(() => undefined);
    try {
      setSources(await sourcesRequest);
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
      setSources([]);
    }
    // An account with no form connected yet is still a connection, and the card
    // has to say so or "Connect Tally" reads as "your key didn't save".
    try {
      setConnections(await connectionsRequest);
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
        toast.success(
          `Re-sync: ${r.remoteState.toLowerCase()}${
            r.removedDuplicates ? `, removed ${r.removedDuplicates} duplicate webhook(s)` : ''
          }.`,
        );
      } else {
        await providersApi.reinstall(source.id);
        toast.success('Webhook reinstalled with the same URL and secret — nothing else to change.');
      }
      await load();
    } catch (e) {
      toast.error(e instanceof ApiError ? e.message : String(e));
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
      if (r.warning) toast.warn(r.warning);
      else if (norm(source.connectionMethod) === 'API')
        toast.success('Disconnected, and the webhook was removed from your form. Leads already received are untouched.');
      else toast.warn('Disconnected. Remove the webhook in your form tool too, or it keeps firing at a dead URL.');
      setConfirmDisconnect(null);
      await load();
    } catch (e) {
      toast.error(
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

  // Every source of a form provider — installed through its API, or its URL
  // pasted by hand before the Webhook card existed — sits on that provider's
  // card. Sources from before providers existed carry no provider and were all
  // Tally. The Webhook card lists the custom ones.
  const providerSources = (code: string) => (sources ?? []).filter((s) => !isCustomSource(s) && norm(s.provider || 'TALLY') === code);
  const accounts = (code: string) => connections.filter((c) => norm(c.provider) === code);
  const customSources = (sources ?? []).filter(isCustomSource);

  /**
   * The body of a card whose data has not arrived. Named after the card it sits
   * in, because two identical "Loading connections…" spinners tell you only
   * that something is happening — not which connection is still unknown.
   *
   * The cards render throughout rather than being replaced by a spinner: the
   * grid used to disappear entirely while lead sources loaded, which kept
   * TelnyxCard — it loads itself — from mounting until they had arrived, so its
   * request started after theirs finished instead of alongside.
   */
  const LoadingBody: React.FC<{ what: string }> = ({ what }) => (
    <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 flex items-center gap-2">
      <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Checking your {what} connection…
    </div>
  );

  const loading = sources === null;

  /**
   * A form provider we hold a key for, so we install and repair the webhook.
   * Tally and Typeform are the same card with different words. A function, not
   * a component: a component declared here would be a new type on every render
   * and remount its rows each time.
   */
  const formProviderCard = (code: 'TALLY' | 'TYPEFORM', title: string, empty: string) => {
    const mine = providerSources(code);
    const conns = accounts(code);
    return (
      <IntegrationCard
        key={code}
        icon={
          <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
            <Link2 className="w-5 h-5" />
          </div>
        }
        title={title}
        blurb="Pick a form — we install the webhook for you"
        connected={mine.length > 0 || conns.length > 0}
        loading={loading}
        accent="border-emerald-500/40"
        action={{
          // An account with no form yet gets its own label: "Connect Tally"
          // next to a Connected badge reads as if the key never saved.
          label: mine.length > 0 ? 'Manage / add form' : conns.length > 0 ? 'Add a form' : `Connect ${title}`,
          icon: mine.length > 0 ? <Settings2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />,
          onClick: () => setConnect(code),
          className: 'bg-emerald-600 hover:bg-emerald-500 text-on-accent shadow-md shadow-emerald-950',
        }}
      >
        {loading ? (
          <LoadingBody what={title} />
        ) : mine.length > 0 ? (
          mine.map((s) => <SourceRow {...rowProps(s)} />)
        ) : conns.length > 0 ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            <strong className="text-slate-200">{conns[0].label || conns[0].accountEmail || 'Account'}</strong> is
            connected, but no form is selected yet. Add one and its submissions start creating leads.
          </div>
        ) : (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            {empty}
          </div>
        )}
      </IntegrationCard>
    );
  };

  return (
    <div className="space-y-4">
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-xs text-rose-200 leading-relaxed">
            <div className="font-semibold text-rose-100">Can't reach the backend</div>
            {error}
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        {/* Telnyx — the outbound side: the account the AI agent calls from. */}
        <TelnyxCard />

        {/* Scheduling — Calendly and Cal.com, of which exactly one can be live.
            Renders both cards from ONE status request: two self-loading cards
            would disagree with each other for as long as the slower one took,
            on a screen whose whole job is saying what is connected. */}
        <SchedulingCards />

        {/* Google Sheets — self-loading, like Telnyx: its account is not a lead source. */}
        <GoogleSheetsCard />

        {/* Webhook — one URL for any app or form; the owner maps the first payload's fields. Hidden when the server has it off. */}
        <CustomWebhookCard
          sources={customSources}
          loading={loading}
          onOpenSource={openInLeadSources}
          onAdd={() => setWebhookWizard({ sourceId: null })}
          onMap={(id) => setWebhookWizard({ sourceId: id })}
        />
        {/* HubSpot — self-loading too; hidden where the server has it switched off. */}
        <HubSpotCard />

        {/* Tally and Typeform — we hold the key, so we install and repair the webhook. */}
        {formProviderCard(
          'TALLY',
          'Tally',
          'Paste your Tally API key once, pick the forms you want, and we install the webhook on each of them — nothing to copy by hand.',
        )}
        {formProviderCard(
          'TYPEFORM',
          'Typeform',
          'Paste a Typeform personal access token once, pick the forms you want, and we install the webhook on each of them — nothing to copy by hand.',
        )}

      </div>

      {connect && (
        <ConnectModal
          provider={connect}
          onClose={() => setConnect(null)}
          onConnected={() => {
            void load();
          }}
          onOpenSource={(id) => {
            setConnect(null);
            openInLeadSources(id);
          }}
          onManual={() => {
            setConnect(null);
            setWebhookWizard({ sourceId: null });
          }}
        />
      )}

      {webhookWizard && (
        <CustomWebhookWizard
          sourceId={webhookWizard.sourceId}
          onClose={() => {
            setWebhookWizard(null);
            void load();
          }}
          onChanged={() => void load()}
        />
      )}
    </div>
  );
};
