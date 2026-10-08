import React, { useEffect, useState } from 'react';
import { AlertTriangle, KeyRound, X } from 'lucide-react';
import { useAuth } from '../../context/AuthContext';
import { messageFor } from '../../lib/api';
import { MIN_PASSWORD_LENGTH, PasswordField } from './AuthLayout';

/**
 * Changing the password signs the user out everywhere, this browser included
 * (the server revokes every session). The modal says so up front, and on
 * success AuthContext takes the user to the login page.
 */
export const ChangePasswordModal: React.FC<{ onClose: () => void }> = ({ onClose }) => {
  const { changePassword } = useAuth();
  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && !saving) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, saving]);

  const mismatch = confirmPassword.length > 0 && confirmPassword !== newPassword;

  const handleSubmit = async (e: React.FormEvent): Promise<void> => {
    e.preventDefault();
    if (newPassword.length < MIN_PASSWORD_LENGTH) {
      setError(`New password must be at least ${MIN_PASSWORD_LENGTH} characters.`);
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New passwords do not match.');
      return;
    }
    if (newPassword === oldPassword) {
      setError('New password must be different from the current one.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      await changePassword({ oldPassword, newPassword, confirmPassword });
      // Unmounted by now: the session ended and the app navigated to /login.
    } catch (err) {
      setError(messageFor(err));
      setSaving(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-950/80 backdrop-blur-md animate-in fade-in duration-150"
      role="dialog"
      aria-modal="true"
      aria-labelledby="change-password-title"
    >
      <div className="relative w-full max-w-md bg-slate-900 border border-slate-700/80 rounded-2xl shadow-2xl overflow-hidden text-slate-100">
        <div className="p-5 bg-slate-950 border-b border-slate-800 flex items-center justify-between">
          <div className="flex items-center gap-2.5 min-w-0">
            <div className="w-9 h-9 rounded-xl bg-emerald-600/20 text-emerald-400 flex items-center justify-center border border-emerald-500/30 shrink-0">
              <KeyRound className="w-5 h-5" />
            </div>
            <div className="min-w-0">
              <h3 id="change-password-title" className="text-base font-bold text-white truncate">
                Change password
              </h3>
              <p className="text-xs text-slate-400">You will be signed out on all devices afterwards.</p>
            </div>
          </div>
          <button
            onClick={onClose}
            disabled={saving}
            aria-label="Close"
            className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer disabled:cursor-not-allowed shrink-0"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <form onSubmit={(e) => void handleSubmit(e)} className="p-5 space-y-4">
          {error && (
            <div role="alert" className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2 text-xs">
              <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
              <span className="text-rose-200 leading-relaxed">{error}</span>
            </div>
          )}
          <PasswordField
            label="Current password"
            name="oldPassword"
            value={oldPassword}
            autoComplete="current-password"
            onChange={setOldPassword}
            disabled={saving}
            required
            maxLength={128}
          />
          <PasswordField
            label="New password"
            name="newPassword"
            value={newPassword}
            autoComplete="new-password"
            onChange={setNewPassword}
            disabled={saving}
            required
            minLength={MIN_PASSWORD_LENGTH}
            maxLength={128}
            hint={`At least ${MIN_PASSWORD_LENGTH} characters.`}
          />
          <PasswordField
            label="Confirm new password"
            name="confirmPassword"
            value={confirmPassword}
            autoComplete="new-password"
            onChange={setConfirmPassword}
            disabled={saving}
            required
            maxLength={128}
            error={mismatch ? 'Passwords do not match.' : null}
          />

          <div className="flex justify-end gap-2 pt-1 text-xs">
            <button
              type="button"
              onClick={onClose}
              disabled={saving}
              className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={saving || mismatch}
              className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg font-semibold transition-colors cursor-pointer disabled:opacity-60 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : 'Change password'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};
