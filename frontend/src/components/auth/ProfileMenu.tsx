import React, { useState } from 'react';
import { KeyRound, LogOut, MonitorSmartphone } from 'lucide-react';
import { displayName, initialsFor, useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { ChangePasswordModal } from './ChangePasswordModal';

/**
 * The signed-in user's card at the foot of both shells' sidebars: who they are,
 * and the account actions — change password, sign out everywhere.
 */
export const ProfileMenu: React.FC = () => {
  const { user, organization, roleName, logoutAll } = useAuth();
  const [open, setOpen] = useState(false);
  const [changingPassword, setChangingPassword] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

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

  const action =
    'w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs font-medium text-slate-300 hover:text-slate-100 hover:bg-slate-800/70 transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed';

  return (
    <>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />
          <div className="absolute bottom-full left-3 right-3 mb-2 z-50 bg-slate-900 border border-slate-800 rounded-xl p-4 shadow-xl space-y-3">
            <div className="flex items-center gap-2.5">
              <div className="w-10 h-10 rounded-full bg-slate-800 flex items-center justify-center text-sm font-bold text-slate-300 shrink-0">
                {initialsFor(user)}
              </div>
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-100 truncate">{displayName(user)}</div>
                <div className="text-xs text-emerald-400 truncate">{roleName}</div>
              </div>
            </div>
            <dl className="text-xs space-y-2">
              <div>
                <dt className="text-slate-500 uppercase tracking-wider text-2xs">Email</dt>
                <dd className="text-slate-200 truncate">{user?.email}</dd>
              </div>
              {user?.phone && (
                <div>
                  <dt className="text-slate-500 uppercase tracking-wider text-2xs">Phone</dt>
                  <dd className="text-slate-200 truncate">{user.phone}</dd>
                </div>
              )}
              <div>
                <dt className="text-slate-500 uppercase tracking-wider text-2xs">Organization</dt>
                <dd className="text-slate-200 truncate">{organization?.name}</dd>
              </div>
            </dl>
            {error && <p className="text-xs text-rose-300">{error}</p>}
            <div className="pt-2 border-t border-slate-800 space-y-0.5">
              <button
                type="button"
                className={action}
                onClick={() => {
                  setOpen(false);
                  setChangingPassword(true);
                }}
              >
                <KeyRound className="w-3.5 h-3.5" /> Change password
              </button>
              <button type="button" className={action} disabled={busy} onClick={() => void signOutEverywhere()}>
                <MonitorSmartphone className="w-3.5 h-3.5" /> {busy ? 'Signing out…' : 'Sign out on all devices'}
              </button>
            </div>
          </div>
        </>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="menu"
        className="min-w-0 flex-1 flex items-center gap-2.5 text-left rounded-lg p-1.5 cursor-pointer hover:bg-slate-800/70"
      >
        <div className="w-8 h-8 rounded-full bg-slate-800 flex items-center justify-center text-xs font-bold text-slate-300 shrink-0">
          {initialsFor(user)}
        </div>
        <div className="min-w-0 flex-1">
          <div className="text-sm font-semibold text-slate-200 truncate leading-tight">{displayName(user)}</div>
          <div className="text-xs text-slate-500 leading-tight truncate">{roleName}</div>
        </div>
      </button>
      {changingPassword && <ChangePasswordModal onClose={() => setChangingPassword(false)} />}
    </>
  );
};

/** The plain sign-out button that sits beside the profile card. */
export const SignOutButton: React.FC<{ iconClassName?: string }> = ({ iconClassName = 'w-4 h-4' }) => {
  const { logout } = useAuth();
  return (
    <button
      onClick={logout}
      title="Sign out"
      aria-label="Sign out"
      className="p-2 rounded-lg text-slate-400 hover:text-rose-300 hover:bg-rose-500/10 transition-colors cursor-pointer shrink-0"
    >
      <LogOut className={iconClassName} />
    </button>
  );
};
