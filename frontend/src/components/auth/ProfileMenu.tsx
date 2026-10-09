import React, { useEffect, useRef, useState } from 'react';
import {
  ArrowLeftRight,
  Briefcase,
  Check,
  ChevronDown,
  KeyRound,
  Loader2,
  LogOut,
  MonitorSmartphone,
  ShieldCheck,
} from 'lucide-react';
import { displayName, initialsFor, useAuth } from '../../context/AuthContext';
import { messageFor, type Role } from '../../lib/api';
import { ChangePasswordModal } from './ChangePasswordModal';

const PROFILE_OPTIONS: Record<Role, { label: string; hint: string; icon: React.ReactNode }> = {
  owner: { label: 'Owner', hint: 'Manage the business, team and setup', icon: <ShieldCheck className="w-4 h-4" /> },
  agent: { label: 'Agent', hint: 'Work your leads and appointments', icon: <Briefcase className="w-4 h-4" /> },
};

const item =
  'w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-slate-300 hover:text-emerald-300 hover:bg-emerald-500/5 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed';

/**
 * The signed-in user's menu at the right of the navbar, in both shells: who
 * they are, which view they are in (and, holding Owner plus another role, the
 * switch between the two), and the account actions.
 */
export const ProfileMenu: React.FC = () => {
  const { user, organization, roleName, role, profiles, switchProfile, logout, logoutAll } = useAuth();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const canSwitch = profiles.length > 1;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const signOutEverywhere = async (): Promise<void> => {
    if (!window.confirm('Sign out on all devices, including this one?')) return;
    setError(null);
    setBusy(true);
    try {
      await logoutAll();
    } catch (err) {
      setError(messageFor(err));
      setBusy(false);
    }
  };

  const subtitle = canSwitch && role ? PROFILE_OPTIONS[role].label : roleName;

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="flex items-center gap-2 pl-1 pr-2 py-1 rounded-lg hover:bg-emerald-500/5 cursor-pointer transition-colors"
      >
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-600 flex items-center justify-center text-xs font-bold text-on-accent">
          {initialsFor(user)}
        </div>
        <div className="hidden md:block text-left max-w-[160px]">
          <p className="text-xs font-semibold text-slate-100 leading-none truncate">{displayName(user)}</p>
          {subtitle && (
            <p className="text-2xs text-emerald-400 font-medium mt-1 leading-none truncate flex items-center gap-1">
              {canSwitch && <ArrowLeftRight className="w-3 h-3 shrink-0" />}
              {subtitle}
            </p>
          )}
        </div>
        <ChevronDown
          className={`w-3.5 h-3.5 text-slate-500 hidden md:block transition-transform ${open ? 'rotate-180' : ''}`}
        />
      </button>

      {open && (
        <div
          role="menu"
          className="absolute right-0 top-full mt-1.5 w-64 bg-slate-900 border border-slate-800 rounded-xl shadow-2xl overflow-hidden z-50"
        >
          <div className="px-3 py-2.5 border-b border-slate-800">
            <p className="text-sm font-semibold text-slate-100 truncate">{displayName(user)}</p>
            <p className="text-2xs text-slate-500 truncate">{user?.email}</p>
            <p className="text-2xs text-slate-500 truncate mt-0.5">
              {roleName} · {organization?.name}
            </p>
          </div>

          {canSwitch && (
            <div className="p-2 border-b border-slate-800">
              <p className="px-1 mb-1.5 text-2xs font-bold uppercase tracking-wider text-slate-500">View as</p>
              <div role="radiogroup" aria-label="View as" className="space-y-1">
                {profiles.map((profile) => {
                  const option = PROFILE_OPTIONS[profile];
                  const active = profile === role;
                  return (
                    <button
                      key={profile}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => {
                        setOpen(false);
                        switchProfile(profile);
                      }}
                      className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-left border transition-colors cursor-pointer ${
                        active ? 'bg-emerald-500/10 border-emerald-500/30' : 'border-transparent hover:bg-slate-800/70'
                      }`}
                    >
                      <span className={active ? 'text-emerald-400' : 'text-slate-500'}>{option.icon}</span>
                      <span className="flex-1 min-w-0">
                        <span className={`block text-xs font-semibold ${active ? 'text-emerald-200' : 'text-slate-200'}`}>
                          {option.label}
                        </span>
                        <span className="block text-2xs text-slate-500 truncate">{option.hint}</span>
                      </span>
                      {active && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    </button>
                  );
                })}
              </div>
            </div>
          )}

          <div className="py-1">
            <button
              type="button"
              role="menuitem"
              className={item}
              onClick={() => {
                setOpen(false);
                setChangingPassword(true);
              }}
            >
              <KeyRound className="w-3.5 h-3.5" /> Change password
            </button>
            <button
              type="button"
              role="menuitem"
              className={item}
              disabled={busy}
              onClick={() => void signOutEverywhere()}
            >
              <MonitorSmartphone className="w-3.5 h-3.5" /> {busy ? 'Signing out…' : 'Sign out on all devices'}
            </button>
            {error && <p className="px-3 py-1 text-2xs text-rose-300">{error}</p>}
          </div>

          <div className="border-t border-slate-800 py-1">
            <button
              type="button"
              role="menuitem"
              onClick={logout}
              disabled={busy}
              className="w-full flex items-center gap-2 px-3 py-2 text-xs font-medium text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <LogOut className="w-3.5 h-3.5" />}
              Sign out
            </button>
          </div>
        </div>
      )}
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </div>
  );
};
