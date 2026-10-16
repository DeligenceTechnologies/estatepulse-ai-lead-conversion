import React, { useEffect, useState } from 'react';
import { AlertTriangle, Check, Copy, Plus, Webhook } from 'lucide-react';
import type { LeadSourceConfig } from '../../api/client';
import { customWebhookEnabled } from '../../utils/customWebhookApi';
import { customStatus } from '../../utils/customWebhookMapping';
import { CustomWebhookWizard } from '../customwebhook/CustomWebhookWizard';
import { IntegrationCard } from './IntegrationCard';

/**
 * Custom webhooks — a URL any app can post a lead to, mapped by the owner from
 * the first payload. Reads the same source list as the other lead-source
 * cards; what is specific (mapping, switching on) happens in the wizard.
 * Hidden entirely where the server has the feature switched off.
 */

const link = 'text-2xs font-bold text-slate-400 hover:text-white transition-colors cursor-pointer';

const CopyUrl: React.FC<{ value: string }> = ({ value }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      title="Copy webhook URL"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(value);
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        } catch {
          /* clipboard blocked — the URL is still in the wizard to select by hand */
        }
      }}
      className="p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors cursor-pointer shrink-0"
    >
      {done ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

export const CustomWebhookCard: React.FC<{
  /** The organization's custom webhook sources, from the shared list. */
  sources: LeadSourceConfig[];
  loading: boolean;
  onChanged: () => void;
  onOpenSource: (id: string) => void;
}> = ({ sources, loading, onChanged, onOpenSource }) => {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [wizard, setWizard] = useState<{ sourceId: string | null } | null>(null);

  useEffect(() => {
    void customWebhookEnabled().then(setEnabled, () => setEnabled(false));
  }, []);

  // Switched off on this server (CUSTOM_WEBHOOK_ENABLED): no card at all.
  if (enabled === false) return null;

  return (
    <>
      <IntegrationCard
        icon={
          <div className="w-9 h-9 rounded-xl bg-amber-500/20 text-amber-400 flex items-center justify-center border border-amber-500/30 shrink-0">
            <Webhook className="w-5 h-5" />
          </div>
        }
        title="Custom webhook"
        blurb="Any app posts a lead here — you map its fields once"
        connected={sources.some((s) => (s.ingestStatus ?? '').toUpperCase() === 'ACTIVE')}
        loading={loading || enabled === null}
        accent="border-amber-500/40"
        action={{
          label: sources.length > 0 ? 'Add custom webhook' : 'Create a custom webhook',
          icon: <Plus className="w-4 h-4" />,
          onClick: () => setWizard({ sourceId: null }),
          className: 'bg-slate-800 hover:bg-slate-700 text-slate-100',
        }}
      >
        {sources.length === 0 ? (
          <div className="bg-slate-950 border border-slate-800/80 rounded-xl p-4 text-xs text-slate-400 leading-relaxed">
            For an app we have no connector for — a CRM, Zapier, your own website. We give you a URL; when its first payload arrives you
            point at the phone, the name and the rest, and every payload after that becomes a lead.
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
                  <span className={`text-2xs font-bold uppercase px-2 py-0.5 rounded-full border shrink-0 ${st.cls}`}>{st.label}</span>
                  {s.webhookUrl && <CopyUrl value={s.webhookUrl} />}
                </div>
                {needsAttention && (
                  <div className="flex items-start gap-1.5 text-2xs text-amber-300 mt-1.5">
                    <AlertTriangle className="w-3 h-3 shrink-0 mt-0.5" />
                    <span>
                      {(s.mappingStatus ?? '').toUpperCase() === 'CONFIGURED'
                        ? 'Mapped but not switched on yet — deliveries are being held.'
                        : 'A payload has arrived. Map its fields so deliveries can become leads.'}
                    </span>
                  </div>
                )}
                <div className="flex flex-wrap gap-x-3 gap-y-1 pt-1.5">
                  <button type="button" className={link} onClick={() => setWizard({ sourceId: s.id })}>
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

      {wizard && (
        <CustomWebhookWizard
          sourceId={wizard.sourceId}
          onClose={() => {
            setWizard(null);
            onChanged();
          }}
          onChanged={onChanged}
        />
      )}
    </>
  );
};
