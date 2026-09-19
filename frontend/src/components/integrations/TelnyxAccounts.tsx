import React, { useState } from 'react';
import { AlertTriangle, Check, Loader2, Pencil, PhoneCall, Trash2, X } from 'lucide-react';
import {
  TelnyxAccount,
  activateTelnyxAccount,
  deleteTelnyxAccount,
  renameTelnyxAccount,
} from '../../utils/assistantApi';

/**
 * The shelf of saved Telnyx accounts.
 *
 * An org can keep several on file — one per market, one per brand — but exactly
 * one is active, and the active one places every call and sends every message.
 * So this list is a radio button, not a set of toggles: the only thing you can
 * do to a dormant account is switch to it, rename it, or forget it.
 *
 * It renders nothing at all for an org with a single account, because a list of
 * one is just noise on the page where you connected it.
 */
export const TelnyxAccounts: React.FC<{
  accounts: TelnyxAccount[];
  /** Status and list both move when an account is switched, so the parent reloads. */
  onChange: () => void;
}> = ({ accounts, onChange }) => {
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (accounts.length < 2) return null;

  const run = async (key: string, fn: () => Promise<unknown>) => {
    setBusy(key);
    setError(null);
    try {
      await fn();
      onChange();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(null);
    }
  };

  const startRename = (a: TelnyxAccount) => {
    setRenaming(a.id);
    setDraft(a.label || '');
  };

  const commitRename = (id: string) => {
    const label = draft.trim();
    if (!label) return setRenaming(null);
    void run(`rename:${id}`, () => renameTelnyxAccount(id, label)).then(() => setRenaming(null));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-slate-200">Saved accounts</h4>
        <span className="text-[11px] text-slate-500">One is active at a time</span>
      </div>

      {error && (
        <div className="flex items-start gap-1.5 text-[11px] text-rose-300 bg-rose-950/40 border border-rose-900/40 rounded-lg px-3 py-1.5">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
        </div>
      )}

      <div className="space-y-1.5">
        {accounts.map((a) => (
          <div
            key={a.id}
            className={`bg-slate-950 border rounded-xl px-3 py-2.5 ${
              a.active ? 'border-emerald-500/40' : 'border-slate-800/80'
            }`}
          >
            <div className="flex items-center gap-2">
              <PhoneCall
                className={`w-4 h-4 shrink-0 ${a.active ? 'text-emerald-400' : 'text-slate-600'}`}
              />

              <div className="min-w-0 flex-1">
                {renaming === a.id ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      autoFocus
                      value={draft}
                      onChange={(e) => setDraft(e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter') commitRename(a.id);
                        if (e.key === 'Escape') setRenaming(null);
                      }}
                      placeholder="Account name"
                      className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-2 py-1 text-xs text-white focus:outline-none focus:border-emerald-500"
                    />
                    <button
                      type="button"
                      onClick={() => commitRename(a.id)}
                      className="p-1 rounded-lg text-emerald-400 hover:bg-slate-800 cursor-pointer"
                    >
                      <Check className="w-3.5 h-3.5" />
                    </button>
                    <button
                      type="button"
                      onClick={() => setRenaming(null)}
                      className="p-1 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 cursor-pointer"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-semibold text-white truncate">
                      {a.label || 'Unnamed account'}
                    </div>
                    <div className="text-[11px] text-slate-500 truncate font-mono">
                      {a.apiKeyMasked || 'no key'} · {a.fromNumber || 'no number'}
                    </div>
                  </>
                )}
              </div>

              {a.active ? (
                <span className="text-[10px] font-bold uppercase px-2 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1 shrink-0">
                  <Check className="w-3 h-3" /> Active
                </span>
              ) : (
                <button
                  type="button"
                  disabled={busy !== null}
                  onClick={() => void run(`use:${a.id}`, () => activateTelnyxAccount(a.id))}
                  className="text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-800 text-slate-300 hover:text-white hover:border-slate-600 transition-colors cursor-pointer disabled:opacity-40 shrink-0 flex items-center gap-1.5"
                >
                  {busy === `use:${a.id}` && <Loader2 className="w-3 h-3 animate-spin" />}
                  Use this
                </button>
              )}

              {renaming !== a.id && (
                <button
                  type="button"
                  title="Rename"
                  onClick={() => startRename(a)}
                  className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
                >
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              )}

              <button
                type="button"
                title="Forget this account"
                disabled={busy !== null}
                onClick={() => {
                  if (confirmDelete !== a.id) return setConfirmDelete(a.id);
                  void run(`del:${a.id}`, () => deleteTelnyxAccount(a.id)).then(() =>
                    setConfirmDelete(null),
                  );
                }}
                className={`p-1.5 rounded-lg transition-colors cursor-pointer disabled:opacity-40 shrink-0 ${
                  confirmDelete === a.id
                    ? 'bg-rose-600 text-white'
                    : 'text-slate-500 hover:text-rose-300 hover:bg-slate-800'
                }`}
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>

            {/* Deleting the account in use stops calls outright — nothing is
                promoted in its place, so say so before the second click. */}
            {confirmDelete === a.id && (
              <div className="mt-2 pt-2 border-t border-slate-800/80 text-[11px] text-rose-200 leading-relaxed">
                {a.active
                  ? 'Click again to forget this account. It is the one in use, so calls and SMS stop until you switch to another.'
                  : 'Click again to forget this account and its stored key.'}
              </div>
            )}
          </div>
        ))}
      </div>
    </div>
  );
};
