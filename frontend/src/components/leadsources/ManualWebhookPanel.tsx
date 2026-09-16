import React, { useState } from 'react';
import { AlertTriangle, CheckCircle2, KeyRound, Loader2, X } from 'lucide-react';
import { ApiError, api, type LeadSourceWithSecret } from '../../api/client';
import { CopyField } from './CopyField';

/**
 * Set a source up by hand: we mint the URL and secret, the customer pastes them
 * into whatever form tool they use.
 *
 * The counterpart to ConnectFormPanel, and the option that has to exist: it is
 * the only path for someone who will not hand us an API key that can read every
 * form and every submission in their account. It also covers any form tool we
 * have no adapter for, since the ingest route only cares about the payload.
 */
export const ManualWebhookPanel: React.FC<{
  onClose: () => void;
  onCreated: (leadSourceId: string) => void;
}> = ({ onClose, onCreated }) => {
  const [name, setName] = useState('');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<LeadSourceWithSecret | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleCreate = async () => {
    if (!name.trim() || creating) return;
    setCreating(true);
    try {
      const source = await api.createLeadSource(name.trim());
      setCreated(source);
      setError(null);
      onCreated(source.id);
    } catch (e) {
      setError(e instanceof ApiError ? e.message : String(e));
    } finally {
      setCreating(false);
    }
  };

  if (created) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2">
          <CheckCircle2 className="w-4 h-4 text-emerald-400" />
          <h3 className="text-sm font-bold text-white">
            "{created.name}" created — paste these into your form
          </h3>
        </div>

        <CopyField label="Webhook URL" value={created.webhookUrl ?? ''} />
        <CopyField label="Signing secret" value={created.signingSecret} />

        {/* The single most expensive thing a customer can misunderstand on this
            screen, so it is stated before they close it rather than in a doc. */}
        <div className="bg-amber-500/10 border border-amber-500/30 rounded-xl p-3 text-[11px] text-amber-200 leading-relaxed flex gap-2">
          <KeyRound className="w-3.5 h-3.5 mt-0.5 shrink-0" />
          <span>
            <strong>The signing secret is shown once.</strong> It is encrypted at rest and no API
            response will ever return it again — if you lose it, rotate to get a new one. The webhook
            URL can always be recovered from this screen.
          </span>
        </div>

        <ol className="text-[11px] text-slate-300 space-y-1 list-decimal list-inside leading-relaxed">
          <li>In Tally, open your form → <strong>Integrations</strong> → <strong>Webhooks</strong> → Add webhook.</li>
          <li>Paste the <strong>Webhook URL</strong>.</li>
          <li>Expand <strong>Signing secret</strong> and paste the secret.</li>
          <li>Connect, then submit a test response — it appears in Lead Sources within a few seconds.</li>
        </ol>

        <div className="flex justify-end">
          <button
            onClick={onClose}
            className="px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-white font-bold rounded-xl text-xs transition-colors cursor-pointer"
          >
            Done
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-[11px] text-slate-400 leading-relaxed">
        We generate a webhook URL and a signing secret. You paste them into your form tool yourself —
        we never ask for an API key, and we hold no credential for your account. The trade-off is
        that we cannot repair, pause or remove the webhook for you later.
      </p>

      {error && (
        <div className="bg-rose-500/10 border border-rose-500/30 rounded-xl p-3 flex items-start gap-2">
          <AlertTriangle className="w-3.5 h-3.5 text-rose-400 mt-0.5 shrink-0" />
          <div className="text-[11px] text-rose-200 leading-relaxed">{error}</div>
        </div>
      )}

      <div className="space-y-1">
        <div className="text-[11px] text-slate-400 font-medium">Name this lead source</div>
        <input
          autoFocus
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void handleCreate()}
          placeholder="e.g. Buyer Intake Form (Tally)"
          className="w-full bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white focus:outline-none focus:border-emerald-500"
        />
      </div>

      <div className="flex justify-end gap-2">
        <button
          onClick={onClose}
          className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-300 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
        >
          Cancel
        </button>
        <button
          onClick={() => void handleCreate()}
          disabled={creating || !name.trim()}
          className="px-5 py-2 bg-emerald-600 hover:bg-emerald-500 disabled:opacity-40 text-white font-bold rounded-lg text-xs flex items-center gap-1.5 transition-colors cursor-pointer"
        >
          {creating && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
          Create & show secret
        </button>
      </div>
    </div>
  );
};

/** Shared close button for the modal header. */
export const PanelClose: React.FC<{ onClose: () => void }> = ({ onClose }) => (
  <button
    onClick={onClose}
    className="p-1.5 rounded-lg bg-slate-800 text-slate-400 hover:text-white transition-colors cursor-pointer"
  >
    <X className="w-3.5 h-3.5" />
  </button>
);
