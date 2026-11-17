import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Plus, Webhook } from 'lucide-react';
import type { LeadSourceConfig } from '../../api/client';
import { customWebhookEnabled } from '../../utils/customWebhookApi';
import { customStatus } from '../../utils/customWebhookMapping';
import { IntegrationCard } from './IntegrationCard';
import { IconButton, buttonClass } from '../common/Button';

/**
 * Webhook — one URL any app or form can post a lead to. A form we understand
 * (Tally) is read as a form; anything else is mapped by the owner from its
 * first payload. Reads the same source list as the Tally card; what is
 * specific (mapping, switching on) happens in the wizard the parent opens.
 * Hidden entirely where the server has the feature switched off.
 */

const link = buttonClass({ variant: 'ghost', size: 'sm' });

const CopyUrl: React.FC<{ value: string }> = ({ value }) => {
  const [done, setDone] = useState(false);
  return (
    <IconButton
      size="sm"
      aria-label="Copy webhook URL"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — the URL is still in the wizard to select by hand */
        }
      }}
      icon={done ? <Check className="text-emerald-400" /> : <Copy />}
    />
  );
};

export const CustomWebhookCard: React.FC<{
  /** The organization's webhook sources, from the shared list. */
  sources: LeadSourceConfig[];
  loading: boolean;
  onOpenSource: (id: string) => void;
  /** Create a new webhook (the wizard). */
  onAdd: () => void;
  /** Open this webhook's mapper. */
  onMap: (id: string) => void;
}> = ({ sources, loading, onOpenSource, onAdd, onMap }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);

  useEffect(() => {
    void customWebhookEnabled().then(setEnabled, () => setEnabled(false));
  }, []);

  // Switched off on this server (CUSTOM_WEBHOOK_ENABLED): no card at all.
  if (enabled === false) return null;

  return (
    <IntegrationCard
      icon={
        <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30 shrink-0">
          <Webhook className="w-5 h-5" />
        </div>
      }
      title="Webhook"
      blurb="One link for any app, form or website"
      connected={sources.some((s) => (s.ingestStatus ?? '').toUpperCase() === 'ACTIVE')}
      loading={loading || enabled === null}
      accent="border-amber-500/40"
      action={{
        label: sources.length > 0 ? 'Add webhook' : 'Create a webhook',
        icon: <Plus className="w-4 h-4" />,
        onClick: onAdd,
        variant: 'secondary',
      }}
    >
      {sources.length === 0 ? (
        <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
          Paste the link into your form, website or Zapier. Match the fields once, and every new entry becomes a lead.
        </div>
      ) : (
        sources.map((s) => {
          const st = customStatus(s);
          const needsAttention = (s.ingestStatus ?? '').toUpperCase() === 'NEEDS_MAPPING';
          return (
            <div key={s.id} className={`bg-slate-950 border rounded-xl px-3 py-2.5 ${needsAttention ? 'border-amber-500/40' : 'border-slate-800/80'}`}>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => onOpenSource(s.id)} title="See its leads on Lead Sources" className="min-w-0 flex-1 text-left group cursor-pointer">
                  <div className="text-xs font-semibold text-white truncate group-hover:text-emerald-300 transition-colors">{s.name}</div>
                  <div className="text-2xs text-slate-500">
                    {s.leadCount ?? 0} lead{(s.leadCount ?? 0) === 1 ? '' : 's'} · {s.deliveryCount ?? 0} deliver{(s.deliveryCount ?? 0) === 1 ? 'y' : 'ies'}
                  </div>
                </button>
                <span className={`text-2xs font-semibold px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>
                {s.webhookUrl && <CopyUrl value={s.webhookUrl} />}
              </div>
              {needsAttention && (
                <div className="flex items-start gap-1.5 text-2xs text-amber-300 mt-1.5">
                  <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                  <span>
                    {(s.mappingStatus ?? '').toUpperCase() === 'CONFIGURED'
                      ? 'Not switched on yet. Entries are on hold.'
                      : 'First entry received. Match its fields to start.'}
                  </span>
                </div>
              )}
              {!needsAttention && (s.mappingStatus ?? '').toUpperCase() === 'NEEDS_REVIEW' && (
                <div className="text-2xs text-slate-400 mt-1.5">Fields matched automatically. Worth a quick check.</div>
              )}
              <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5">
                <button type="button" className={link} onClick={() => onMap(s.id)}>
                  {(s.mappingStatus ?? '').toUpperCase() === 'CONFIGURED' ? 'Edit mapping' : 'Set up mapping'}
                </button>
                <button type="button" className={link} onClick={() => onOpenSource(s.id)}>
                  Deliveries
                </button>
              </div>
            </div>
          );
        })
      )}
    </IntegrationCard>
  );
};
