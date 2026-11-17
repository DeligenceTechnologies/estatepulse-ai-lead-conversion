import React, { useState } from 'react';
import { Check, Pencil, PhoneCall, Trash2, X } from 'lucide-react';
import { toast } from 'react-toastify';
import {
  TelnyxAccount,
  activateTelnyxAccount,
  deleteTelnyxAccount,
  renameTelnyxAccount,
} from '../../utils/assistantApi';
import { IconButton, Button } from '../common/Button';

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
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);

  if (accounts.length < 2) return null;

  const run = async (key: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(key);
    try {
      await fn();
      onChange();
      if (done) toast.success(done);
    } catch (e) {
      toast.error(e instanceof Error ? e.message : String(e));
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
    void run(`rename:${id}`, () => renameTelnyxAccount(id, label), 'Account renamed.').then(() => setRenaming(null));
  };

  return (
    <div className="space-y-2">
      <div className="flex items-baseline justify-between gap-2">
        <h4 className="text-xs font-semibold text-slate-200">Saved accounts</h4>
        <span className="text-xs text-slate-500">One is active at a time</span>
      </div>

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
                    <IconButton
                      size="sm"
                      onClick={() => commitRename(a.id)}
                      aria-label="Save name"
                      icon={<Check className="text-emerald-400" />}
                    />
                    <IconButton size="sm" onClick={() => setRenaming(null)} aria-label="Cancel" icon={<X />} />
                  </div>
                ) : (
                  <>
                    <div className="text-xs font-semibold text-white truncate">
                      {a.label || 'Unnamed account'}
                    </div>
                    <div className="text-xs text-slate-500 truncate font-mono">
                      {/* The number tells accounts apart without putting a
                          credential fragment on screen. */}
                      {a.fromNumber || 'no number assigned'}
                    </div>
                    {!a.hasPublicKey && (
                      <div className="text-2xs text-amber-400 truncate">No public key — its webhooks are ignored</div>
                    )}
                  </>
                )}
              </div>

              {a.active ? (
                <span className="text-2xs font-bold uppercase px-2 py-0.5 rounded-full border bg-emerald-500/20 text-emerald-300 border-emerald-500/40 flex items-center gap-1 shrink-0">
                  <Check className="w-3 h-3" /> Active
                </span>
              ) : (
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busy !== null && busy !== `use:${a.id}`}
                  loading={busy === `use:${a.id}`}
                  onClick={() => void run(`use:${a.id}`, () => activateTelnyxAccount(a.id), 'Account activated.')}
                >
                  Use this
                </Button>
              )}

              {renaming !== a.id && (
                <IconButton size="sm" aria-label="Rename" onClick={() => startRename(a)} icon={<Pencil />} />
              )}

              <IconButton
                size="sm"
                variant={confirmDelete === a.id ? 'danger' : 'ghost'}
                aria-label={confirmDelete === a.id ? 'Click again to forget this account' : 'Forget this account'}
                disabled={busy !== null && busy !== `del:${a.id}`}
                loading={busy === `del:${a.id}`}
                icon={<Trash2 />}
                className={confirmDelete === a.id ? '' : 'hover:text-rose-300!'}
                onClick={() => {
                  if (confirmDelete !== a.id) return setConfirmDelete(a.id);
                  void run(`del:${a.id}`, () => deleteTelnyxAccount(a.id), 'Account deleted.').then(() =>
                    setConfirmDelete(null),
                  );
                }}
              />
            </div>

            {/* Deleting the account in use stops calls outright — nothing is
                promoted in its place, so say so before the second click. */}
            {confirmDelete === a.id && (
              <div className="mt-2 pt-2 border-t border-slate-800/80 text-xs text-rose-200 leading-relaxed">
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
