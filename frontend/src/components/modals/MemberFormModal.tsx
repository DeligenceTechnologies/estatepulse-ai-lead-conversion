import React, { useEffect, useState } from 'react';
import {
  AlertTriangle,
  Check,
  CheckCircle2,
  Eye,
  EyeOff,
  Loader2,
  MailWarning,
  Save,
  Clock,
  Gauge,
  Globe,
  ShieldCheck,
  UserCog,
  UserPlus,
  X,
} from 'lucide-react';
import { messageFor } from '../../lib/api';
import {
  createMember,
  updateMember,
  type CreatedMember,
  type MemberUpdate,
  type Role,
  type TeamMember,
} from '../../utils/usersApi';
import { DEFAULT_WORKING_HOURS, normalizeWeek, type WorkingDay } from '../../utils/workingHours';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { WorkingHoursEditor, invalidDay } from '../team/WorkingHoursEditor';

const MIN_PASSWORD_LENGTH = 8;
const DEFAULT_MAX_LEADS = 25;
const MAX_LEADS_LIMIT = 1000;

/** The device's zone, else the server default. */
const browserTimeZone = (): string => {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Kolkata';
  } catch {
    return 'Asia/Kolkata';
  }
};

const sameWeek = (a: readonly WorkingDay[], b: readonly WorkingDay[]): boolean =>
  JSON.stringify(normalizeWeek(a)) === JSON.stringify(normalizeWeek(b));

interface MemberFormModalProps {
  orgId: string;
  /** Every role of the organization; the picker offers these. */
  roles: Role[];
  /** The member being edited; omitted to add a new one. */
  member?: TeamMember;
  /** A new member's starting timezone and hours: the organization's settings, when known. */
  defaults?: { timezone: string; workingHours: WorkingDay[] };
  /** The signed-in user's id: they cannot change their own roles here. */
  currentUserId?: string;
  onClose: () => void;
  /** Called after the server confirms, so the list can reload. */
  onSaved: (member: TeamMember) => void;
}

const field =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-white focus:outline-none focus:border-emerald-500 disabled:opacity-60';
const label = 'block text-slate-300 font-semibold mb-1';

/** A titled block of the form. */
const Section: React.FC<{ title: string; hint?: string; children: React.ReactNode }> = ({ title, hint, children }) => (
  <section className="space-y-3">
    <div className="flex items-baseline justify-between gap-2 border-b border-slate-800 pb-1.5">
      <h4 className="text-2xs font-bold uppercase tracking-wider text-slate-400">{title}</h4>
      {hint && <span className="text-2xs text-slate-500">{hint}</span>}
    </div>
    {children}
  </section>
);

/**
 * Add or edit a team member. Mounted only while open, so its state always
 * starts from the member (or empty) instead of needing a reset.
 *
 * Adding asks for no password: the server generates one and emails it with
 * the sign-in email to the new member, and the modal then says whether that
 * email went out. Editing sends only what changed; its optional password field
 * is an admin reset — the way in when the welcome email never arrived.
 */
export const MemberFormModal: React.FC<MemberFormModalProps> = ({
  orgId,
  roles,
  member,
  defaults,
  currentUserId,
  onClose,
  onSaved,
}) => {
  const editing = member !== undefined;
  const defaultRole = roles.find((r) => r.name.toLowerCase() === 'agent') ?? roles.find((r) => !r.isSystem) ?? roles[0];

  const [firstName, setFirstName] = useState(member?.firstName ?? '');
  const [lastName, setLastName] = useState(member?.lastName ?? '');
  const [email, setEmail] = useState(member?.email ?? '');
  const [phone, setPhone] = useState(member?.phone ?? '');
  const [roleIds, setRoleIds] = useState<string[]>(
    member ? member.roles.map((r) => r.id) : defaultRole ? [defaultRole.id] : [],
  );
  const [timezone, setTimezone] = useState(member?.timezone ?? defaults?.timezone ?? browserTimeZone());
  const [maxLeads, setMaxLeads] = useState(String(member?.maxActiveLeads ?? DEFAULT_MAX_LEADS));
  const [workingHours, setWorkingHours] = useState<WorkingDay[]>(normalizeWeek(member?.workingHours ?? defaults?.workingHours ?? DEFAULT_WORKING_HOURS));
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Set once a new member is created; the form is replaced by the outcome. */
  const [created, setCreated] = useState<CreatedMember | null>(null);

  const isSelf = editing && member.id === currentUserId;
  const leadCap = Number(maxLeads);
  const leadCapValid = maxLeads.trim() !== '' && Number.isInteger(leadCap) && leadCap >= 0 && leadCap <= MAX_LEADS_LIMIT;

  const close = (): void => {
    if (!saving) onClose();
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  /** Only what changed, so an unrelated edit never re-checks email uniqueness. */
  const changes = (): MemberUpdate => {
    if (!member) return {};
    const out: MemberUpdate = {};
    if (firstName.trim() !== member.firstName) out.firstName = firstName.trim();
    if (lastName.trim() !== member.lastName) out.lastName = lastName.trim();
    if (email.trim().toLowerCase() !== member.email.toLowerCase()) out.email = email.trim();
    if (phone.trim() !== member.phone) out.phone = phone.trim();
    if (timezone !== member.timezone) out.timezone = timezone;
    if (leadCapValid && leadCap !== member.maxActiveLeads) out.maxActiveLeads = leadCap;
    if (!sameWeek(workingHours, member.workingHours ?? DEFAULT_WORKING_HOURS)) out.workingHours = workingHours;
    const current = member.roles.map((r) => r.id);
    if (roleIds.length !== current.length || roleIds.some((id) => !current.includes(id))) out.roleIds = roleIds;
    if (password) out.password = password;
    return out;
  };

  const pending = changes();
  const nothingToSave = editing && Object.keys(pending).length === 0;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (saving) return;

    if (!firstName.trim() || !lastName.trim() || !email.trim() || !phone.trim()) {
      setError('First name, last name, email and phone are required.');
      return;
    }
    if (roleIds.length === 0) {
      setError('Choose at least one role.');
      return;
    }
    if (!leadCapValid) {
      setError(`Lead capacity must be a whole number from 0 to ${MAX_LEADS_LIMIT}.`);
      return;
    }
    if (invalidDay(workingHours) !== -1) {
      setError('Every working day must end after it starts.');
      return;
    }
    if (editing && password && password.length < MIN_PASSWORD_LENGTH) {
      setError(`Password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }

    setSaving(true);
    setError(null);
    try {
      if (editing) {
        onSaved(await updateMember(member.id, pending));
        onClose();
        return;
      }
      const result = await createMember({
        orgId,
        firstName: firstName.trim(),
        lastName: lastName.trim(),
        email: email.trim(),
        phone: phone.trim(),
        timezone,
        maxActiveLeads: leadCap,
        workingHours,
        roleIds,
      });
      onSaved(result);
      // Stay open: whether the sign-in details reached them is the one thing
      // the owner must see, and closing would hide a failed email.
      setCreated(result);
      setSaving(false);
    } catch (err) {
      setError(messageFor(err));
      setSaving(false);
    }
  };

  const Icon = editing ? UserCog : UserPlus;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="member-form-title"
    >
      <div className="relative w-full max-w-2xl bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100 max-h-[90vh] flex flex-col">
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
              <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="member-form-title" className="text-base font-bold text-white truncate">
                {editing ? `Edit ${member.firstName} ${member.lastName}` : 'Add Member'}
              </h3>
              <p className="text-xs text-slate-400">
                {editing
                  ? 'Profile, work setup, schedule and access.'
                  : 'Creates an account and emails them their sign-in details.'}
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

        {created ? (
          <CreatedResult member={created} onDone={onClose} />
        ) : (
          <form onSubmit={(e) => void handleSubmit(e)} className="p-5 pb-0 space-y-6 text-xs overflow-y-auto custom-scrollbar">
            {error && (
              <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
                <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
                <span className="text-rose-200 leading-relaxed">{error}</span>
              </div>
            )}

            <Section title="Profile">
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={label} htmlFor="member-first-name">First Name</label>
                  <input
                    id="member-first-name"
                    className={field}
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    autoComplete="off"
                    maxLength={100}
                    required
                    disabled={saving}
                  />
                </div>
                <div>
                  <label className={label} htmlFor="member-last-name">Last Name</label>
                  <input
                    id="member-last-name"
                    className={field}
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    autoComplete="off"
                    maxLength={100}
                    required
                    disabled={saving}
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={label} htmlFor="member-email">Email</label>
                  <input
                    id="member-email"
                    type="email"
                    className={field}
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    autoComplete="off"
                    maxLength={255}
                    required
                    disabled={saving}
                  />
                  <p className="text-slate-500 mt-1">This is what they sign in with.</p>
                </div>
                <div>
                  <label className={label} htmlFor="member-phone">Phone</label>
                  <input
                    id="member-phone"
                    type="tel"
                    className={field}
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    autoComplete="off"
                    maxLength={50}
                    placeholder="+91 98765 43210"
                    required
                    disabled={saving}
                  />
                </div>
              </div>
            </Section>

            <Section title="Work setup" hint="Used for routing and scheduling">
              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={label} htmlFor="member-timezone">
                    <Globe className="inline w-3 h-3 mr-1 -mt-0.5 text-slate-500" />
                    Timezone
                  </label>
                  <TimezoneSelect
                    id="member-timezone"
                    className={`${field} cursor-pointer`}
                    value={timezone}
                    onChange={setTimezone}
                    disabled={saving}
                  />
                  <p className="text-slate-500 mt-1">Their working hours are read in this zone.</p>
                </div>
                <div>
                  <label className={label} htmlFor="member-max-leads">
                    <Gauge className="inline w-3 h-3 mr-1 -mt-0.5 text-slate-500" />
                    Lead capacity
                  </label>
                  <div className="relative">
                    <input
                      id="member-max-leads"
                      type="number"
                      inputMode="numeric"
                      min={0}
                      max={MAX_LEADS_LIMIT}
                      step={1}
                      className={`${field} pr-24 ${leadCapValid ? '' : 'border-rose-500/60'}`}
                      value={maxLeads}
                      onChange={(e) => setMaxLeads(e.target.value)}
                      disabled={saving}
                    />
                    <span className="absolute inset-y-0 right-3 flex items-center text-slate-500 pointer-events-none">
                      active leads
                    </span>
                  </div>
                  <p className="text-slate-500 mt-1">The most leads they hold at once. 0 = they take none.</p>
                </div>
              </div>
            </Section>

            <Section title="Working hours" hint="Default: Mon–Fri, 9 AM – 6 PM">
              <div className="flex items-center gap-1.5 text-slate-500 -mt-1">
                <Clock className="w-3 h-3" />
                Times are in {timezone.replace(/_/g, ' ')}.
              </div>
              <WorkingHoursEditor value={workingHours} onChange={setWorkingHours} disabled={saving} />
            </Section>

            <Section title="Access">
              <div>
                <div className="flex items-baseline justify-between mb-1">
                  <span className="block text-slate-300 font-semibold" id="member-roles-label">Roles</span>
                  <span className="text-2xs text-slate-500">{roleIds.length} selected</span>
                </div>
                <RolePicker
                  roles={roles}
                  selected={roleIds}
                  onChange={setRoleIds}
                  disabled={saving || isSelf}
                />
                <p className="text-slate-500 mt-1">
                  {isSelf
                    ? 'You cannot change your own roles.'
                    : 'Pick one or more. They get every permission of each role — manage roles under Roles & Permissions.'}
                </p>
              </div>
              {editing ? (
                <div>
                  <label className={label} htmlFor="member-password">
                    New Password (optional)
                  </label>
                  <div className="relative">
                    <input
                      id="member-password"
                      type={showPassword ? 'text' : 'password'}
                      className={`${field} pr-10`}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      autoComplete="new-password"
                      minLength={password ? MIN_PASSWORD_LENGTH : undefined}
                      maxLength={128}
                      disabled={saving}
                    />
                    <button
                      type="button"
                      onClick={() => setShowPassword((v) => !v)}
                      aria-label={showPassword ? 'Hide password' : 'Show password'}
                      className="absolute inset-y-0 right-0 px-3 flex items-center text-slate-500 hover:text-slate-300 cursor-pointer"
                    >
                      {showPassword ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
                    </button>
                  </div>
                  <p className="text-slate-500 mt-1">Leave empty to keep their current password.</p>
                </div>
              ) : (
                <p className="bg-slate-950/60 border border-slate-800 rounded-lg p-3 text-slate-400 leading-relaxed">
                  A secure password is generated automatically and emailed to them together with their sign-in email.
                </p>
              )}
            </Section>

            <div className="sticky bottom-0 -mx-5 px-5 py-3 bg-slate-900 border-t border-slate-800 flex justify-end gap-2">
              <button
                type="button"
                onClick={close}
                disabled={saving}
                className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={saving || nothingToSave}
                title={nothingToSave ? 'Nothing has changed yet' : undefined}
                className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold flex items-center gap-1.5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
              >
                {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Save className="w-3.5 h-3.5" />}
                {editing ? 'Save changes' : 'Add Member'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
};

/** Multi-select of the organization's roles, as toggleable rows (Owner first). */
const RolePicker: React.FC<{
  roles: Role[];
  selected: string[];
  onChange: (ids: string[]) => void;
  disabled: boolean;
}> = ({ roles, selected, onChange, disabled }) => {
  if (roles.length === 0) {
    return <p className="bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-slate-500">No roles available</p>;
  }
  const toggle = (id: string): void =>
    onChange(selected.includes(id) ? selected.filter((s) => s !== id) : [...selected, id]);
  return (
    <div
      role="group"
      aria-labelledby="member-roles-label"
      className="bg-slate-950 border border-slate-800 rounded-lg divide-y divide-slate-800/70 max-h-48 overflow-y-auto custom-scrollbar"
    >
      {roles.map((role) => {
        const on = selected.includes(role.id);
        return (
          <button
            key={role.id}
            type="button"
            role="checkbox"
            aria-checked={on}
            onClick={() => toggle(role.id)}
            disabled={disabled}
            className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
              on ? 'bg-emerald-500/5' : ''
            } ${disabled ? 'opacity-60 cursor-not-allowed' : 'cursor-pointer hover:bg-slate-800/40'}`}
          >
            <span
              className={`w-4 h-4 rounded-[5px] border flex items-center justify-center shrink-0 ${
                on ? 'bg-emerald-600 border-emerald-500 text-on-accent' : 'border-slate-600'
              }`}
            >
              {on && <Check className="w-3 h-3" strokeWidth={3} />}
            </span>
            <span className="flex-1 min-w-0">
              <span className={`flex items-center gap-1 font-semibold ${on ? 'text-white' : 'text-slate-300'}`}>
                {role.isSystem && <ShieldCheck className="w-3 h-3 text-emerald-400" />}
                {role.name}
              </span>
              {role.description && <span className="block text-2xs text-slate-500 truncate">{role.description}</span>}
            </span>
            <span className="text-2xs text-slate-500 shrink-0">
              {role.isSystem ? 'Full access' : `${role.permissions.length} permissions`}
            </span>
          </button>
        );
      })}
    </div>
  );
};

/** What happened after an add: the account exists either way; the email may not have gone. */
const CreatedResult: React.FC<{ member: CreatedMember; onDone: () => void }> = ({ member, onDone }) => {
  const { sent, to, reason } = member.credentialsEmail;
  return (
    <div className="p-5 space-y-4 text-xs">
      <div className="flex items-start gap-3">
        <div
          className={`w-9 h-9 rounded-xl flex items-center justify-center border shrink-0 ${
            sent
              ? 'bg-emerald-600/20 text-emerald-400 border-emerald-500/30'
              : 'bg-amber-500/15 text-amber-300 border-amber-500/30'
          }`}
        >
          {sent ? <CheckCircle2 className="w-5 h-5" /> : <MailWarning className="w-5 h-5" />}
        </div>
        <div className="space-y-1 min-w-0">
          <h4 className="text-sm font-bold text-white">
            {member.firstName} {member.lastName} has been added
          </h4>
          {sent ? (
            <p className="text-slate-300 leading-relaxed">
              Their sign-in email and password were sent to <span className="font-semibold text-white break-all">{to}</span>.
              They can change the password after signing in.
            </p>
          ) : (
            <p className="text-amber-200/90 leading-relaxed">
              {reason ?? 'The welcome email could not be sent'}, so they do not have a password yet. Use{' '}
              <span className="font-semibold">Edit</span> on their row to set one, and share it with them securely.
            </p>
          )}
        </div>
      </div>
      <div className="flex justify-end">
        <button
          type="button"
          onClick={onDone}
          autoFocus
          className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold transition-colors cursor-pointer"
        >
          Done
        </button>
      </div>
    </div>
  );
};
