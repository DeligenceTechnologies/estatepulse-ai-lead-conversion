import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, Loader2, MailWarning, UserPlus, X } from 'lucide-react';
import { messageFor } from '../../lib/api';
import { createAgent, memberName, type CreateAgentResult } from '../../utils/agentsApi';

interface AddAgentModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after the server confirms the creation, so the roster can reload. */
  onCreated: () => void;
}

/**
 * The owner sets the agent's first password here, and it is emailed to the
 * agent when the server has SMTP configured. There is still no reset link, and
 * delivery is not guaranteed — so the modal reports whether the email actually
 * went out rather than assuming it did, and tells the owner to hand the
 * password over themselves when it did not.
 *
 * The fields are empty on purpose. Every other modal in this app prefills demo
 * values; this one creates a real account with a real password, and a prefilled
 * password is a password somebody ships.
 */
export const AddAgentModal: React.FC<AddAgentModalProps> = ({ isOpen, onClose, onCreated }) => {
  const [firstName, setFirstName] = useState('');
  const [lastName, setLastName] = useState('');
  const [email, setEmail] = useState('');
  const [phone, setPhone] = useState('');
  // The agent_profiles.max_active_leads column default, shown rather than left
  // blank so the owner can see the value they are accepting.
  const [leadCap, setLeadCap] = useState('25');
  const [password, setPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once the server confirms the creation; the form is replaced by it. */
  const [result, setResult] = useState<CreateAgentResult | null>(null);

  if (!isOpen) return null;

  const close = (): void => {
    if (saving) return;
    setFirstName('');
    setLastName('');
    setEmail('');
    setPhone('');
    setLeadCap('25');
    setPassword('');
    setError(null);
    setResult(null);
    onClose();
  };

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();

    const cap = Number(leadCap);
    if (!Number.isInteger(cap) || cap < 1) {
      // agent_profiles has CHECK (max_active_leads > 0), so 0 and decimals are
      // rejected here rather than on a round trip.
      setError('Max active leads must be a whole number of 1 or more.');
      return;
    }

    setSaving(true);
    setError(null);

    try {
      const created = await createAgent({
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        password,
        maxActiveLeads: cap,
      });
      // The roster reloads straight away, but the modal stays open: whether the
      // password reached the agent is the one thing the owner has to see, and
      // closing over it would leave them assuming it did.
      onCreated();
      setResult(created);
    } catch (err) {
      // The server's own message is preferred where it has one — "Password must
      // be at least 8 characters" beats a generic form error.
      setError(messageFor(err));
    } finally {
      setSaving(false);
    }
  };

  const field = 'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 disabled:opacity-60';

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150">
      <div className="relative w-full max-w-lg bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100">
        {/* Header */}
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30">
              <UserPlus className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-white">Add Agent</h3>
              <p className="text-xs text-slate-400">
                Creates a real account in your organization and sets its first password
              </p>
            </div>
          </div>

          <button
            onClick={close}
            disabled={saving}
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        {result ? (
          /* What actually happened, rather than a modal that just vanishes.
             The two outcomes need different things from the owner: one is done,
             the other means they still have to pass the password on. */
          <div className="p-5 space-y-4 text-xs">
            <div className="flex items-start gap-2.5">
              <div
                className={`w-9 h-9 rounded-xl flex items-center justify-center border shrink-0 ${
                  result.credentialsEmail.sent
                    ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
                    : 'bg-amber-500/20 text-amber-300 border-amber-500/40'
                }`}
              >
                {result.credentialsEmail.sent ? (
                  <CheckCircle2 className="w-5 h-5" />
                ) : (
                  <MailWarning className="w-5 h-5" />
                )}
              </div>
              <div className="min-w-0">
                <h4 className="text-sm font-bold text-white">
                  {memberName(result)} was added
                </h4>
                <p className="text-slate-400 leading-relaxed mt-0.5">
                  {result.credentialsEmail.sent ? (
                    <>
                      Their sign-in details were emailed to{' '}
                      <span className="text-slate-200 font-mono">{result.credentialsEmail.to}</span>.
                    </>
                  ) : (
                    <>
                      The account is ready, but the email did not go out
                      {result.credentialsEmail.reason
                        ? ` — ${result.credentialsEmail.reason.toLowerCase()}`
                        : ''}
                      .
                    </>
                  )}
                </p>
              </div>
            </div>

            {!result.credentialsEmail.sent && (
              <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-amber-400 mt-0.5 shrink-0" />
                <span className="text-amber-100 leading-relaxed">
                  Give {result.firstName ?? 'them'} the password you just set, by some other
                  channel. It is not stored anywhere and cannot be shown again.
                </span>
              </div>
            )}

            <div className="flex items-center justify-end pt-1">
              <button
                type="button"
                onClick={close}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold transition-colors cursor-pointer"
              >
                Done
              </button>
            </div>
          </div>
        ) : (
        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4 text-xs">
          {error && (
            <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
              <span className="text-rose-200 leading-relaxed">{error}</span>
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-slate-300 font-semibold mb-1">First Name</label>
              <input
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
              <label className="block text-slate-300 font-semibold mb-1">Last Name</label>
              <input
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
            <label className="block text-slate-300 font-semibold mb-1">Email</label>
            <input
              type="email"
              required
              maxLength={255}
              disabled={saving}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              className={field}
            />
            <p className="text-2xs text-slate-500 mt-1">This is the address they sign in with.</p>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">
              Phone <span className="text-slate-500 font-normal">(optional)</span>
            </label>
            <input
              type="tel"
              maxLength={50}
              disabled={saving}
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              className={field}
            />
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1" htmlFor="add-lead-cap">
              Max Active Leads
            </label>
            <input
              id="add-lead-cap"
              type="number"
              required
              min={1}
              step={1}
              disabled={saving}
              value={leadCap}
              onChange={(e) => setLeadCap(e.target.value)}
              className={`${field} font-mono`}
            />
            <p className="text-2xs text-slate-500 mt-1">
              The most open leads this agent may hold. Stored now; nothing assigns leads yet.
            </p>
          </div>

          <div>
            <label className="block text-slate-300 font-semibold mb-1">Initial Password</label>
            <input
              type="password"
              required
              minLength={8}
              autoComplete="new-password"
              disabled={saving}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              className={field}
            />
            <p className="text-2xs text-slate-500 mt-1">
              At least 8 characters. It is emailed to the agent when this server has email
              configured — you will be told either way. They cannot change it from the app yet.
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
              disabled={saving}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <UserPlus className="w-3.5 h-3.5" />}
              {saving ? 'Creating…' : 'Create Agent'}
            </button>
          </div>
        </form>
        )}
      </div>
    </div>
  );
};
