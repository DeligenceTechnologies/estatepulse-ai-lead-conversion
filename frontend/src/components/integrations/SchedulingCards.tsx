import React, { useCallback, useEffect, useState } from 'react';
import {
  AlertTriangle,
  CalendarCheck,
  CalendarClock,
  CheckCircle2,
  ExternalLink,
  Link2,
  Loader2,
  Plus,
  RefreshCw,
  Settings2,
  Unlink,
  Users,
} from 'lucide-react';
import { ApiError, messageFor } from '../../lib/api';
import {
  connectCalCom,
  disconnectOrganizationCalendar,
  getOrganizationCalendar,
  listCalComTeams,
  listCalendarEventTypes,
  listCalendarMembers,
  openCalendlyPopup,
  startOrganizationCalendarConnect,
  syncCalendarMembers,
  syncOrganizationCalendar,
  type CalComTeamOption,
  type CalendarEventType,
  type CalendarMember,
  type CalendarProviderId,
  type MemberSyncResult,
  type OrganizationCalendarStatus,
  type SyncResult,
} from '../../utils/calendarApi';
import { PanelClose } from '../leadsources/ManualWebhookPanel';
import { IntegrationCard } from './IntegrationCard';

/**
 * Scheduling — the office's one booking account.
 *
 * Calendly and Cal.com are ALTERNATIVES, not a stack: exactly one is connected
 * at a time, and connecting one retires the other. They offer the same thing
 * for this product's purposes — a shared team roster and round-robin
 * assignment — and Cal.com does it on a cheaper plan, which is why an office
 * can start there and move to Calendly later without losing the appointments
 * it already has.
 *
 * Both cards are rendered from ONE status request. Two self-loading cards would
 * each have to ask, and they would disagree with each other for as long as the
 * slower one took — on a screen whose entire job is saying what is connected.
 *
 * Whichever provider is live, everything after connecting is the same: the
 * member roster, the bookable pages, the sweep. That is why there is one manage
 * view rather than two.
 */

/** One labelled fact about the live connection. Matches TelnyxCard's. */
const Fact: React.FC<{ label: string; value: string; mono?: boolean }> = ({ label, value, mono }) => (
  <div className="flex items-baseline justify-between gap-3">
    <span className="text-[11px] text-slate-500 shrink-0">{label}</span>
    <span className={`text-[11px] text-slate-200 truncate ${mono ? 'font-mono' : ''}`}>{value}</span>
  </div>
);

/** "2 minutes ago" — good enough, and it never claims more precision than it has. */
function relativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const secs = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 1000));
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}

/** Both providers' vocabularies, spelled the way each one's UI spells it. */
/** The scheduling account's own role for a member, in the words Cal.com and Calendly use. */
const MEMBER_ROLE_LABEL: Record<string, string> = {
  owner: 'Owner',
  admin: 'Admin',
  user: 'Member',
  member: 'Member',
};

const POOLING_LABEL: Record<string, string> = {
  round_robin: 'Round robin',
  collective: 'Collective',
  multi_pool: 'Multi-pool',
  managed: 'Managed',
};

const PROVIDER_LABEL: Record<CalendarProviderId, string> = {
  calendly: 'Calendly',
  cal: 'Cal.com',
};

const panel = 'bg-slate-950 border border-slate-800/80 rounded-xl';

// ---------------------------------------------------------------------------
// Connecting Cal.com — a pasted key, then a team
// ---------------------------------------------------------------------------

/**
 * Cal.com's connect flow, which is nothing like Calendly's.
 *
 * There is no consent screen to send anyone to: the owner generates a key in
 * Cal.com and pastes it. Two steps, because one key may unlock several teams
 * and which one an office books through is not something we can infer — so the
 * key is checked first (writing nothing), the teams it can see are offered, and
 * only then is a connection created.
 */
const CalComConnectModal: React.FC<{
  replacing: CalendarProviderId | null;
  onClose: () => void;
  onConnected: () => void;
}> = ({ replacing, onClose, onConnected }) => {
  const [apiKey, setApiKey] = useState('');
  const [teams, setTeams] = useState<CalComTeamOption[] | null>(null);
  const [account, setAccount] = useState<string | null>(null);
  const [teamId, setTeamId] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const check = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await listCalComTeams(apiKey);
      setAccount(res.email);
      setTeams(res.teams);
      // Pre-select when there is exactly one real choice, so the common case is
      // one click. A Cal.com organization is not a choice — it is served by a
      // different API tier — so it never counts as that one.
      const usable = res.teams.filter((t) => !t.isOrganization);
      setTeamId(usable.length === 1 ? usable[0].id : null);
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const connect = async () => {
    if (teamId === null) return;
    setBusy(true);
    setError(null);
    try {
      await connectCalCom(apiKey, teamId);
      onConnected();
      onClose();
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
    } finally {
      setBusy(false);
    }
  };

  const usableTeams = (teams ?? []).filter((t) => !t.isOrganization);

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div className="w-full max-w-lg my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end mb-2">
          <PanelClose onClose={onClose} />
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-4 shadow-xl text-slate-100">
          <div>
            <h3 className="text-sm font-bold text-white">Connect Cal.com</h3>
            <p className="text-[11px] text-slate-400">
              Paste an API key from a Cal.com account that owns or administers your team.
            </p>
          </div>

          {replacing && (
            <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2 text-[11px] text-amber-200 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>
                This will disconnect <strong>{PROVIDER_LABEL[replacing]}</strong>. Appointments
                already synced from it are kept — they happened — and each agent stays linked to
                their {PROVIDER_LABEL[replacing]} member in case you switch back.
              </span>
            </div>
          )}

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-[11px] text-rose-200 leading-relaxed">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="space-y-1.5">
            <label htmlFor="cal-api-key" className="text-[11px] font-semibold text-slate-300">
              API key
            </label>
            <input
              id="cal-api-key"
              type="password"
              value={apiKey}
              autoComplete="off"
              spellCheck={false}
              placeholder="cal_live_…"
              onChange={(e) => {
                setApiKey(e.target.value);
                // The teams belong to the key that unlocked them. Keeping the
                // list after an edit would let someone connect team A with key B.
                setTeams(null);
                setTeamId(null);
              }}
              className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-slate-100 font-mono focus:outline-none focus:border-sky-500/60"
            />
            <p className="text-[11px] text-slate-500">
              Cal.com → Settings → Developer → API keys. We store it encrypted and use it only to
              read your team's bookings.
            </p>
          </div>

          {teams === null ? (
            <button
              type="button"
              disabled={busy || apiKey.trim().length === 0}
              onClick={() => void check()}
              className="w-full px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-950 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
            >
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Link2 className="w-4 h-4" />}
              Check key
            </button>
          ) : (
            <>
              <div className={`${panel} p-3 space-y-1.5`}>
                <Fact label="Account" value={account ?? '—'} />
                <Fact label="Teams" value={String(teams.length)} />
              </div>

              {usableTeams.length === 0 ? (
                <div className={`${panel} p-4 text-[11px] text-amber-300 leading-relaxed`}>
                  This key sees no Cal.com <strong>team</strong>. A personal Cal.com account has no
                  shared roster and no round robin, so there is nothing for an office to book
                  through — create a team in Cal.com and try again.
                  {teams.some((t) => t.isOrganization) && (
                    <span className="block mt-1.5 text-slate-400">
                      It does see an organization, which is a different Cal.com tier served by
                      different endpoints. Pick one of its teams instead.
                    </span>
                  )}
                </div>
              ) : (
                <fieldset className="space-y-1.5">
                  <legend className="text-[11px] font-semibold text-slate-300 mb-1.5">
                    Which team do you book through?
                  </legend>
                  {usableTeams.map((t) => (
                    <label
                      key={t.id}
                      className={`${panel} px-3 py-2 flex items-center gap-2.5 cursor-pointer transition-colors ${
                        teamId === t.id ? 'border-sky-500/50' : 'hover:border-slate-700'
                      }`}
                    >
                      <input
                        type="radio"
                        name="cal-team"
                        checked={teamId === t.id}
                        onChange={() => setTeamId(t.id)}
                        className="accent-sky-500"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-xs font-semibold text-white truncate">
                          {t.name}
                        </span>
                        {t.slug && (
                          <span className="block text-[11px] text-slate-500 truncate font-mono">
                            /{t.slug}
                          </span>
                        )}
                      </span>
                    </label>
                  ))}
                </fieldset>
              )}

              <button
                type="button"
                disabled={busy || teamId === null}
                onClick={() => void connect()}
                className="w-full px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-950 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-default"
              >
                {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Plus className="w-4 h-4" />}
                Connect Cal.com
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Managing whichever provider is live
// ---------------------------------------------------------------------------

/**
 * Who is on the office's scheduling team, and what can be booked.
 *
 * Both lists are READS of the provider. Nothing here creates a team member or
 * an event type — that is done in Calendly or Cal.com, by the person who owns
 * the account — so an empty list means their account is empty, and says so
 * rather than offering a button that would fail.
 */
const ManageModal: React.FC<{
  status: OrganizationCalendarStatus;
  onClose: () => void;
  onChange: () => void;
}> = ({ status, onClose, onChange }) => {
  const [members, setMembers] = useState<CalendarMember[] | null>(null);
  const [eventTypes, setEventTypes] = useState<CalendarEventType[] | null>(null);
  /**
   * Why the event-type list is missing, when it is.
   *
   * Its own state rather than folded into `error`, because the two fail
   * independently and because an empty list and a failed read must never render
   * the same. "No active event types" is a claim about their account, and
   * making it when we never got an answer would send someone looking for a page
   * that is already there.
   */
  const [eventTypesError, setEventTypesError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [matched, setMatched] = useState<MemberSyncResult | null>(null);
  const [synced, setSynced] = useState<SyncResult | null>(null);
  const [armedDisconnect, setArmedDisconnect] = useState(false);

  const label = status.provider ? PROVIDER_LABEL[status.provider] : 'Scheduling';

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previous;
    };
  }, [onClose]);

  const load = useCallback(async () => {
    setError(null);
    // Settled, not all: the roster and the event types are separate upstream
    // calls, and one failing is no reason to blank the other.
    const [m, e] = await Promise.allSettled([listCalendarMembers(), listCalendarEventTypes()]);
    if (m.status === 'fulfilled') setMembers(m.value);
    else setError(m.reason instanceof ApiError ? messageFor(m.reason) : String(m.reason));
    if (e.status === 'fulfilled') {
      setEventTypes(e.value);
      setEventTypesError(null);
    } else {
      setEventTypes(null);
      setEventTypesError(e.reason instanceof ApiError ? messageFor(e.reason) : String(e.reason));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      await load();
      onChange();
    } catch (err) {
      setError(err instanceof ApiError ? messageFor(err) : String(err));
    } finally {
      setBusy(null);
    }
  };

  const unlinked = (members ?? []).filter((m) => !m.agentId).length;

  return (
    <div
      className="fixed inset-0 z-50 bg-slate-950/80 backdrop-blur-sm flex items-start justify-center p-4 overflow-y-auto"
      onClick={onClose}
    >
      <div className="w-full max-w-2xl my-8" onClick={(e) => e.stopPropagation()}>
        <div className="flex justify-end mb-2">
          <PanelClose onClose={onClose} />
        </div>

        <div className="bg-slate-900/90 border border-slate-800 rounded-2xl p-5 space-y-5 shadow-xl text-slate-100">
          <div>
            <h3 className="text-sm font-bold text-white">Office {label}</h3>
            <p className="text-[11px] text-slate-400">
              {status.connection?.email ?? 'Not connected'}
              {status.workspaceName ? ` · ${status.workspaceName}` : ''}
              {status.workspaceRole ? ` · ${status.workspaceRole}` : ''}
            </p>
          </div>

          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-[11px] text-rose-200">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          {/* ---------------------------------------------------------------- */}
          {/* Members                                                           */}
          {/* ---------------------------------------------------------------- */}
          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-1.5">
                <Users className="w-3.5 h-3.5 text-slate-400" />
                <h4 className="text-xs font-bold text-white">Team members</h4>
              </div>
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('members', async () => setMatched(await syncCalendarMembers()))}
                className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-700 text-slate-300 hover:text-white hover:border-slate-600 transition-colors cursor-pointer disabled:opacity-40"
              >
                {busy === 'members' ? (
                  <Loader2 className="w-3.5 h-3.5 animate-spin" />
                ) : (
                  'Sync agents'
                )}
              </button>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              People in your {label} account. <span className="text-slate-300">Sync agents</span>{' '}
              links each one to the EstatePulse agent with the same email, so their bookings show up
              under that agent.
            </p>

            {matched && (
              <div className={`${panel} p-2.5 text-[11px] text-slate-300`}>
                {matched.members} team member{matched.members === 1 ? '' : 's'} · {matched.linked} newly
                linked · {matched.unmatched} with no matching agent · {matched.agentsUnlinked} agent
                {matched.agentsUnlinked === 1 ? '' : 's'} not in {label}
              </div>
            )}

            {members === null ? (
              <div className={`${panel} p-4 text-[11px] text-slate-400 flex items-center gap-2`}>
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Reading your {label}{' '}
                members…
              </div>
            ) : members.length === 0 ? (
              <div className={`${panel} p-4 text-[11px] text-slate-400 leading-relaxed`}>
                No team members found. Invite your agents in {label}, then press Sync agents.
              </div>
            ) : (
              <div className="space-y-1.5">
                {members.map((m) => (
                  <div
                    key={m.schedulingUserId}
                    className={`${panel} px-3 py-2 flex items-center gap-2`}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-white truncate">{m.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">{m.email}</div>
                    </div>

                    <span
                      title={`Their role in ${label}`}
                      className="text-[10px] uppercase font-bold text-slate-500 shrink-0"
                    >
                      {MEMBER_ROLE_LABEL[m.role?.toLowerCase()] ?? m.role}
                    </span>

                    {m.agentId ? (
                      <span
                        title="Linked EstatePulse agent"
                        className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-300 border-emerald-500/40 shrink-0 truncate max-w-[11rem]"
                      >
                        Agent: {m.agentName}
                      </span>
                    ) : (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-slate-800 text-slate-400 border-slate-700 shrink-0">
                        Not linked
                      </span>
                    )}

                  </div>
                ))}
              </div>
            )}

            {unlinked > 0 && (
              <div className="flex items-start gap-1.5 text-[11px] text-amber-400 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                {unlinked} team member{unlinked === 1 ? '' : 's'} not linked to an agent. Their
                bookings are skipped until their {label} email matches an agent's email.
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* Event types                                                       */}
          {/* ---------------------------------------------------------------- */}
          <section className="space-y-2">
            <h4 className="text-xs font-bold text-white">Event types</h4>
            <p className="text-[11px] text-slate-500 leading-relaxed">
              The meetings leads can book, managed in {label}. Open one to see the booking page a lead
              uses. A <span className="text-slate-300">Round robin</span> event type lets {label}{' '}
              choose which agent hosts.
            </p>

            {eventTypesError ? (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2 text-[11px] text-amber-200 leading-relaxed">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                <span>{eventTypesError}</span>
              </div>
            ) : eventTypes === null ? (
              <div className={`${panel} p-4 text-[11px] text-slate-400 flex items-center gap-2`}>
                <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Reading your event types…
              </div>
            ) : eventTypes.length === 0 ? (
              <div className={`${panel} p-4 text-[11px] text-slate-400 leading-relaxed`}>
                No active event types. Create one in {label} — a round robin event type needs a team
                plan.
              </div>
            ) : (
              <div className="space-y-1.5">
                {eventTypes.map((et) => (
                  <div key={et.uri} className={`${panel} px-3 py-2 flex items-center gap-2`}>
                    <div className="min-w-0 flex-1">
                      <div className="text-xs font-semibold text-white truncate">{et.name}</div>
                      <div className="text-[11px] text-slate-500 truncate">
                        {et.durationMinutes} min{et.ownerName ? ` · Host: ${et.ownerName}` : ''}
                      </div>
                    </div>

                    {et.poolingType && (
                      <span className="text-[10px] font-bold px-2 py-0.5 rounded-full border bg-sky-500/20 text-sky-300 border-sky-500/40 shrink-0">
                        {POOLING_LABEL[et.poolingType] ?? et.poolingType}
                      </span>
                    )}

                    {et.schedulingUrl && (
                      <a
                        href={et.schedulingUrl}
                        target="_blank"
                        rel="noreferrer"
                        title="Open the booking page leads use"
                        className="p-1 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0"
                      >
                        <ExternalLink className="w-3.5 h-3.5" />
                      </a>
                    )}
                  </div>
                ))}
              </div>
            )}
          </section>

          {/* ---------------------------------------------------------------- */}
          {/* Sync & disconnect                                                 */}
          {/* ---------------------------------------------------------------- */}
          <section className="space-y-2 pt-1 border-t border-slate-800">
            {synced && (
              <div className={`${panel} p-2.5 text-[11px] text-slate-300`}>
                {synced.scanned} booking{synced.scanned === 1 ? '' : 's'} checked · {synced.created}{' '}
                new · {synced.updated} updated · {synced.skippedNoLead} not from a known lead ·{' '}
                {synced.skippedNoAgent} hosted by an unlinked team member
              </div>
            )}

            <div className="flex items-center gap-2">
              <button
                type="button"
                disabled={busy !== null}
                onClick={() => run('sync', async () => setSynced(await syncOrganizationCalendar()))}
                className="flex-1 px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 bg-slate-800 hover:bg-slate-700 text-slate-100 transition-colors cursor-pointer disabled:opacity-40"
              >
                {busy === 'sync' ? (
                  <Loader2 className="w-4 h-4 animate-spin" />
                ) : (
                  <RefreshCw className="w-4 h-4" />
                )}
                Sync bookings now
              </button>

              <button
                type="button"
                disabled={busy !== null}
                onClick={() => {
                  // Two presses. Disconnecting stops every agent's bookings
                  // reaching the product, so it must not be a stray click.
                  if (!armedDisconnect) {
                    setArmedDisconnect(true);
                    return;
                  }
                  setArmedDisconnect(false);
                  void run('disconnect', async () => {
                    await disconnectOrganizationCalendar();
                    onClose();
                  });
                }}
                className={`px-4 py-2 rounded-xl text-xs font-bold flex items-center justify-center gap-1.5 border transition-colors cursor-pointer disabled:opacity-40 ${
                  armedDisconnect
                    ? 'bg-rose-500/20 border-rose-500/50 text-rose-200'
                    : 'border-slate-700 text-slate-300 hover:text-white hover:border-slate-600'
                }`}
              >
                <Unlink className="w-4 h-4" />
                {armedDisconnect ? 'Confirm disconnect' : 'Disconnect'}
              </button>
            </div>

            <p className="text-[11px] text-slate-500 leading-relaxed">
              Bookings sync automatically every few minutes; Sync bookings now just does it
              immediately. Disconnecting keeps appointments already synced and each agent's link, so
              reconnecting picks up where it left off.
            </p>
          </section>
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// The two cards
// ---------------------------------------------------------------------------

export const SchedulingCards: React.FC = () => {
  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [manage, setManage] = useState(false);
  const [calConnect, setCalConnect] = useState(false);
  const [connecting, setConnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      setStatus(await getOrganizationCalendar());
      setError(null);
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
      setStatus({
        provider: null,
        providers: [],
        syncEnabled: false,
        connection: null,
        workspaceName: null,
        workspaceRole: null,
        membersSyncedAt: null,
      });
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const connectCalendly = async () => {
    setConnecting(true);
    setError(null);
    try {
      const { authorizeUrl } = await startOrganizationCalendarConnect();
      // The popup's own result is only a hint; the reload below is what
      // actually decides whether we are connected.
      await openCalendlyPopup(authorizeUrl);
      await load();
    } catch (e) {
      setError(e instanceof ApiError ? messageFor(e) : String(e));
    } finally {
      setConnecting(false);
    }
  };

  const loading = status === null;
  const live = status?.provider ?? null;
  const conn = status?.connection ?? null;
  const needsReauth = conn?.status === 'error';
  const providerOf = (id: CalendarProviderId) => status?.providers.find((p) => p.id === id) ?? null;

  /** The shared body of whichever card is the connected one. */
  const connectedBody = (id: CalendarProviderId) => (
    <div className={`${panel} p-3 space-y-1.5`}>
      <Fact label="Account" value={conn?.email || '—'} />
      {status?.workspaceName && <Fact label="Team" value={status.workspaceName} />}
      <Fact label="Role" value={status?.workspaceRole ?? '—'} />
      <Fact label="Last sync" value={relativeTime(conn?.lastSyncedAt ?? null)} />
      <Fact label="Members matched" value={relativeTime(status?.membersSyncedAt ?? null)} />

      <div className="pt-1.5 mt-1.5 border-t border-slate-800/80 space-y-1">
        <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Reading the whole team's bookings
        </div>
        {status?.syncEnabled ? (
          <div className="flex items-center gap-1.5 text-[11px] text-emerald-400">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> Background sync running
          </div>
        ) : (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-400 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Background sync is off on this server — use Sync now to pull bookings
          </div>
        )}
        {status?.membersSyncedAt === null && (
          <div className="flex items-start gap-1.5 text-[11px] text-amber-400 leading-relaxed">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            No members matched yet — until an agent is linked to a {PROVIDER_LABEL[id]} member,
            their bookings cannot be attributed
          </div>
        )}
      </div>
    </div>
  );

  /** The body of the card that is NOT connected. */
  const offerBody = (id: CalendarProviderId, blurb: React.ReactNode) => {
    const p = providerOf(id);
    if (p && !p.canConnect) {
      return (
        <div className={`${panel} p-4 text-[11px] text-slate-400 leading-relaxed`}>
          {p.reason ?? `${PROVIDER_LABEL[id]} is not available on this server yet.`}
        </div>
      );
    }
    return (
      <div className={`${panel} p-4 text-[11px] text-slate-400 leading-relaxed space-y-2`}>
        {blurb}
        {live && live !== id && (
          <p className="flex items-start gap-1.5 text-amber-400">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            Connecting this disconnects {PROVIDER_LABEL[live]}. One office, one live calendar.
          </p>
        )}
      </div>
    );
  };

  return (
    <>
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 lg:col-span-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200 leading-relaxed">{error}</div>
        </div>
      )}

      {/* Calendly */}
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-sky-600/20 text-sky-300 flex items-center justify-center border border-sky-500/30 shrink-0">
            <CalendarCheck className="w-5 h-5" />
          </div>
        }
        title="Calendly"
        blurb={
          live === 'calendly' && conn?.email
            ? conn.email
            : 'One office account — every agent books through it'
        }
        connected={live === 'calendly' && Boolean(conn?.connected)}
        loading={loading}
        accent="border-sky-500/40"
        action={{
          // Reauth first: a parked connection is still `live`, and offering
          // "Manage" for one whose credentials Calendly has stopped accepting
          // would open a screen where every list fails.
          label: loading
            ? 'Checking connection…'
            : connecting
              ? 'Waiting for Calendly…'
              : live === 'calendly' && needsReauth
                ? 'Reconnect Calendly'
                : live === 'calendly'
                  ? 'Manage members & pages'
                  : 'Connect Calendly',
          icon:
            live === 'calendly' && !needsReauth ? (
              <Settings2 className="w-4 h-4" />
            ) : (
              <Plus className="w-4 h-4" />
            ),
          onClick: () => {
            if (live === 'calendly' && !needsReauth) setManage(true);
            else void connectCalendly();
          },
          className: 'bg-sky-600 hover:bg-sky-500 text-white shadow-md shadow-sky-950',
        }}
      >
        {loading ? (
          <div className={`${panel} p-4 text-[11px] text-slate-400 flex items-center gap-2`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Checking your Calendly
            connection…
          </div>
        ) : live === 'calendly' && needsReauth ? (
          <div className={`${panel} p-4 text-[11px] text-amber-300 leading-relaxed flex items-start gap-1.5`}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {conn?.lastError ?? 'Calendly stopped accepting our credentials. Reconnect to resume.'}
          </div>
        ) : live === 'calendly' ? (
          connectedBody('calendly')
        ) : (
          offerBody(
            'calendly',
            <>
              <p>
                Connect the account that owns your team's Calendly — it must be an{' '}
                <span className="text-slate-200">owner or admin</span> there, because that is what
                lets us read every member's bookings from one connection.
              </p>
              <p className="flex items-start gap-1.5">
                <Link2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Round-robin pages need a paid Calendly team plan.
              </p>
            </>,
          )
        )}
      </IntegrationCard>

      {/* Cal.com */}
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-indigo-600/20 text-indigo-300 flex items-center justify-center border border-indigo-500/30 shrink-0">
            <CalendarClock className="w-5 h-5" />
          </div>
        }
        title="Cal.com"
        blurb={
          live === 'cal' && conn?.email
            ? conn.email
            : 'The same team booking, on a cheaper plan'
        }
        connected={live === 'cal' && Boolean(conn?.connected)}
        loading={loading}
        accent="border-indigo-500/40"
        action={{
          label: loading
            ? 'Checking connection…'
            : live === 'cal' && needsReauth
              ? 'Reconnect Cal.com'
              : live === 'cal'
                ? 'Manage members & pages'
                : 'Connect Cal.com',
          icon:
            live === 'cal' && !needsReauth ? (
              <Settings2 className="w-4 h-4" />
            ) : (
              <Plus className="w-4 h-4" />
            ),
          onClick: () => {
            if (live === 'cal' && !needsReauth) setManage(true);
            else setCalConnect(true);
          },
          className: 'bg-indigo-600 hover:bg-indigo-500 text-white shadow-md shadow-indigo-950',
        }}
      >
        {loading ? (
          <div className={`${panel} p-4 text-[11px] text-slate-400 flex items-center gap-2`}>
            <Loader2 className="w-3.5 h-3.5 animate-spin shrink-0" /> Checking your Cal.com
            connection…
          </div>
        ) : live === 'cal' && needsReauth ? (
          <div className={`${panel} p-4 text-[11px] text-amber-300 leading-relaxed flex items-start gap-1.5`}>
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
            {conn?.lastError ?? 'Cal.com stopped accepting our API key. Reconnect to resume.'}
          </div>
        ) : live === 'cal' ? (
          connectedBody('cal')
        ) : (
          offerBody(
            'cal',
            <>
              <p>
                Paste an API key from a Cal.com account that owns or administers your{' '}
                <span className="text-slate-200">team</span>, then pick the team. Agents are invited
                in Cal.com and set their own availability there.
              </p>
              <p className="flex items-start gap-1.5">
                <Link2 className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                Round robin comes with a Cal.com team — no OAuth app to register.
              </p>
            </>,
          )
        )}
      </IntegrationCard>

      {manage && status?.connection && (
        <ManageModal
          status={status}
          onClose={() => setManage(false)}
          onChange={() => {
            void load();
          }}
        />
      )}

      {calConnect && (
        <CalComConnectModal
          replacing={live && live !== 'cal' ? live : null}
          onClose={() => setCalConnect(false)}
          onConnected={() => {
            void load();
          }}
        />
      )}
    </>
  );
};
