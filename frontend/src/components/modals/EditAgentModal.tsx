import React, { useState } from 'react';
import { AlertTriangle, Loader2, Save, UserCog, X } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { memberName, updateAgentProfile, type AgentProfileUpdate, type OrganizationMember } from '../../utils/agentsApi';

interface EditAgentModalProps {
  /** The agent being edited. The parent renders this modal only when there is one. */
  member: OrganizationMember;
  onClose: () => void;
  /** Called after the server confirms the save, so the roster can reload. */
  onSaved: () => void;
}

/**
 * The IANA zones this runtime actually knows, which is the same list the server
 * validates against — it checks a zone by handing it to Intl and seeing whether
 * ICU throws. A hardcoded dropdown would be a second list to keep in step, and
 * the one that drifts is always the one the user is looking at.
 */
const RUNTIME_TIMEZONES: string[] = (() => {
  try {
    return Intl.supportedValuesOf('timeZone');
  } catch {
    // Older engines have no supportedValuesOf. The field then offers only what
    // the agent already has, which still saves and still round-trips.
    return [];
  }
})();

/** '' for a null column, so a cleared field and an unset one look the same in the form. */
const text = (v: string | null): string => v ?? '';

/**
 * Editing an existing agent: the two name columns, the sign-in email and the
 * phone on `users`, and the title, timezone and lead cap on `agent_profiles`.
 *
 * Mounted only while an agent is being edited, rather than kept alive behind an
 * `isOpen` flag like AddAgentModal. That is what lets the initial state come
 * straight from the member prop: a fresh mount per agent cannot show a stale
 * form, so there is no reset effect to forget.
 *
 * Only what the server will accept is on this form. Role, membership status,
 * organization and password are absent because they are not editable here — the
 * API rejects all four — and suspension is the separate control on the card.
 */
export const EditAgentModal: React.FC<EditAgentModalProps> = ({ member, onClose, onSaved }) => {
  const [firstName, setFirstName] = useState(text(member.firstName));
  const [lastName, setLastName] = useState(text(member.lastName));
  const [email, setEmail] = useState(member.email);
  const [phone, setPhone] = useState(text(member.phone));
  const [title, setTitle] = useState(text(member.title));
  const [timezone, setTimezone] = useState(member.timezone);
  // A string, not a number: an emptied number input is '', and coercing that to
  // 0 early would show the user a cap the database cannot even store.
  const [leadCap, setLeadCap] = useState(String(member.maxActiveLeads ?? 25));

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // The agent's own zone first, in case the runtime does not list it — it is a
  // real stored value and must never silently disappear from its own form.
  const timezones = RUNTIME_TIMEZONES.includes(timezone)
    ? RUNTIME_TIMEZONES
    : [timezone, ...RUNTIME_TIMEZONES];

  const close = (): void => {
    if (saving) return;
    onClose();
  };

  /**
   * Only what actually changed. The server applies exactly what it is sent, so
   * a narrower body means a title edit never re-checks email uniqueness and
   * never touches a column the owner did not look at.
   */
  const changes = (): AgentProfileUpdate => {
    const out: AgentProfileUpdate = {};
    const cap = Number(leadCap);

    if (firstName.trim() !== text(member.firstName)) out.firstName = firstName.trim();
    if (lastName.trim() !== text(member.lastName)) out.lastName = lastName.trim();
    if (email.trim().toLowerCase() !== member.email.toLowerCase()) out.email = email.trim();
    // '' clears the column; null is how the API spells that.
    if (phone.trim() !== text(member.phone)) out.phone = phone.trim() === '' ? null : phone.trim();
    if (title.trim() !== text(member.title)) out.title = title.trim() === '' ? null : title.trim();
    if (timezone !== member.timezone) out.timezone = timezone;
    if (Number.isInteger(cap) && cap !== member.maxActiveLeads) out.maxActiveLeads = cap;

    return out;
  };

  const pending = changes();
  const nothingToSave = Object.keys(pending).length === 0;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    // Guards the double-submit: a second press while the first is in flight
    // would PATCH twice, and the second would race the first's email check.
    if (saving) return;

    const cap = Number(leadCap);
    if (!Number.isInteger(cap) || cap < 1) {
      // The database enforces max_active_leads > 0; saying so here beats a
      // round trip that comes back as a validation error.
      setError('Lead cap must be a whole number of 1 or more.');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      await updateAgentProfile(member.id, pending);
      onSaved();
      // Closing only here is the point: a failed save leaves the form open with
      // everything the owner typed still in it.
      onClose();
    } catch (err) {
      // The server's own message is preferred where it has one — "An account
      // with that email already exists" beats a generic form error.
      setError(messageFor(err));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 max-h-[90vh] flex flex-col">
        {/* Header */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
              <UserCog className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 className="text-base font-bold text-white truncate">Edit {memberName(member)}</h3>
              <p className="text-[11px] text-slate-400">
                Their profile and contact details. Suspension and password are changed elsewhere.
              </p>
            </div>
          </div>

          <button
            onClick={close}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4 text-xs overflow-y-auto custom-scrollbar">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
              <span className="text-rose-200 leading-relaxed">{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-first-name">
                First Name
              </label>
              <input
                id="edit-first-name"
                type="text"
                required
                maxLength={100}
                disabled={saving}
                value={firstName}
                onChange={(e) => setFirstName(e.target.value)}
                className={field}
              />
            </div>
            <div>
              <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-last-name">
                Last Name
              </label>
              <input
                id="edit-last-name"
                type="text"
                required
                maxLength={100}
                disabled={saving}
                value={lastName}
                onChange={(e) => setLastName(e.target.value)}
                className={field}
              />
            </div>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-email">
              Email
            </label>
            <input
              id="edit-email"
              type="email"
              required
              maxLength={255}
              disabled={saving}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
            <p className="text-[10px] text-slate-500 mt-1">
              This is the address they sign in with — changing it changes their login.
            </p>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-phone">
              Phone <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              id="edit-phone"
              type="tel"
              maxLength={50}
              disabled={saving}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-title">
              Title <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              id="edit-title"
              type="text"
              maxLength={100}
              disabled={saving}
              placeholder="e.g. Senior Listing Agent"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              className={`${field} placeholder:text-slate-600`}
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-timezone">
              Timezone
            </label>
            <select
              id="edit-timezone"
              disabled={saving}
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className={`${field} cursor-pointer`}
            >
              {timezones.map((tz) => (
                <option key={tz} value={tz}>
                  {tz}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="edit-lead-cap">
              Lead Cap
            </label>
            <input
              id="edit-lead-cap"
              type="number"
              required
              min={1}
              step={1}
              disabled={saving}
              value={leadCap}
              onChange={(e) => setLeadCap(e.target.value)}
              className={`${field} font-mono`}
            />
            <p className="text-[10px] text-slate-500 mt-1">
              The most open leads this agent may hold. Nothing assigns leads yet, so this is stored
              and not yet enforced.
            </p>
          </div>

          <div className="flex items-center justify-end gap-2 pt-1">
            <button
              type="button"
              onClick={close}
              disabled={saving}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg font-semibold transition-colors cursor-pointer disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || nothingToSave}
              title={nothingToSave ? 'Nothing has changed yet' : undefined}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
              {saving ? 'Saving…' : 'Save Changes'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
