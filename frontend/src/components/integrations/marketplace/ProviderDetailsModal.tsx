import React, { useCallback, useEffect, useRef, useState } from 'react';
import { BookOpen, Check, Lock, Plus, RefreshCw, Settings2 } from 'lucide-react';
import { messageFor } from '../../../lib/api';
import { integrationsApi, isSyncActive, type MarketplaceProviderDetail } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { SheetModal } from '../../common/SheetModal';
import { Notice } from '../../calendar/shared/ui';
import { ConnectionRow } from './ConnectionRow';
import { ProviderLogo, ProviderStatusBadge } from './parts';

const POLL_MS = 3_000;

/** A provider's details and every account the organization connected for it. */
export const ProviderDetailsModal: React.FC<{
  providerId: string;
  categoryLabel: (id: string) => string;
  canEdit: boolean;
  busyKey: string | null;
  /** Bumped by the page after a connect, so the list re-reads. */
  refreshKey: number;
  onConnect: (providerId: string) => void;
  onReconnect: (connectionId: string) => void;
  onChanged: () => void;
  onClose: () => void;
}> = ({ providerId, categoryLabel, canEdit, busyKey, refreshKey, onConnect, onReconnect, onChanged, onClose }) => {
  const [detail, setDetail] = useState<MarketplaceProviderDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<number | null>(null);

  const load = useCallback(async () => {
    try {
      setDetail(await integrationsApi.provider(providerId));
      setError(null);
    } catch (e) {
      setError(messageFor(e));
    }
  }, [providerId]);

  useEffect(() => {
    void load();
  }, [load, refreshKey]);

  // While a sync is queued or running, re-read so the account shows progress and the result.
  const anyActive = detail?.connections.some((c) => isSyncActive(c.latestRun)) ?? false;
  useEffect(() => {
    if (!anyActive) return;
    timer.current = window.setTimeout(() => void load(), POLL_MS);
    return () => {
      if (timer.current) window.clearTimeout(timer.current);
    };
  }, [anyActive, detail, load]);

  const changed = () => {
    void load();
    onChanged();
  };

  const connecting = busyKey === `connect:${providerId}`;
  const connected = detail?.connections ?? [];
  const canConnect = canEdit && detail?.readiness === 'ready';

  return (
    <SheetModal
      wide
      title={detail?.name ?? 'Integration'}
      subtitle={detail ? detail.categories.map(categoryLabel).join(' · ') : 'Loading…'}
      icon={detail ? <ProviderLogo name={detail.name} logoUrl={detail.logoUrl} size="sm" /> : undefined}
      onClose={onClose}
    >
      {error && !detail && (
        <Notice tone="error">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            <Button size="sm" variant="danger-soft" icon={<RefreshCw />} onClick={() => void load()}>
              Retry
            </Button>
          </div>
        </Notice>
      )}

      {!detail && !error && (
        <div className="space-y-3 animate-pulse" aria-busy>
          <div className="h-4 w-3/4 rounded bg-slate-800" />
          <div className="h-20 rounded-xl bg-slate-800/60" />
          <div className="h-16 rounded-xl bg-slate-800/40" />
        </div>
      )}

      {detail && (
        <div className="space-y-5">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <p className="text-xs text-slate-300 leading-relaxed max-w-2xl">
              {detail.description ?? 'Available in the Nango catalog.'}
            </p>
            <ProviderStatusBadge provider={detail} />
          </div>

          {detail.readiness === 'unsupported' && (
            <Notice tone="info">
              <span className="inline-flex items-center gap-1.5">
                <Lock className="w-3 h-3" /> {detail.readinessMessage}
              </span>{' '}
              It is listed because Nango supports it; EstatePulse will enable it once the lead import for it is built.
            </Notice>
          )}
          {detail.readiness === 'configuration_required' && (
            <Notice tone="warning">
              <div className="space-y-1">
                <div className="font-semibold">Configuration required</div>
                <div>{detail.readinessMessage}</div>
                {detail.requiredScopes.length > 0 && (
                  <div className="text-2xs opacity-80">Scopes the Nango integration needs: {detail.requiredScopes.join(', ')}</div>
                )}
              </div>
            </Notice>
          )}

          {detail.features.length > 0 && (
            <section>
              <h4 className="text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-2">What it does in EstatePulse</h4>
              <ul className="grid gap-1.5 sm:grid-cols-2">
                {detail.features.map((f) => (
                  <li key={f} className="flex items-start gap-2 text-xs text-slate-300">
                    <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0 mt-0.5" />
                    {f}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {detail.supported && (
            <section className="space-y-2">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h4 className="text-2xs font-semibold uppercase tracking-wide text-slate-500">
                  Connected accounts {connected.length > 0 && <span className="text-slate-400">({connected.length})</span>}
                </h4>
                {canConnect && (
                  <Button
                    size="sm"
                    icon={<Plus />}
                    onClick={() => onConnect(providerId)}
                    loading={connecting}
                    disabled={busyKey !== null && !connecting}
                  >
                    {connecting ? 'Connecting…' : connected.length ? 'Connect another account' : 'Connect account'}
                  </Button>
                )}
              </div>

              {connected.length === 0 ? (
                <div className="rounded-xl border border-dashed border-slate-800 px-4 py-6 text-center text-xs text-slate-500">
                  {canConnect
                    ? `No ${detail.name} account connected yet. You can connect as many accounts as you need.`
                    : `No ${detail.name} account connected.`}
                </div>
              ) : (
                <ul className="space-y-2">
                  {connected.map((c, i) => (
                    <ConnectionRow
                      key={c.id}
                      connection={c}
                      index={i}
                      canEdit={canEdit}
                      reconnecting={busyKey === `reconnect:${c.id}`}
                      connectBusy={busyKey !== null}
                      onReconnect={() => onReconnect(c.id)}
                      onChanged={changed}
                    />
                  ))}
                </ul>
              )}
              {!canEdit && (
                <p className="text-2xs text-slate-500 flex items-center gap-1.5">
                  <Settings2 className="w-3 h-3" /> Connecting and managing accounts needs the “Connect and manage lead sources and accounts” permission.
                </p>
              )}
            </section>
          )}

          {detail.docsUrl && (
            <a
              href={detail.docsUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="inline-flex items-center gap-1.5 text-2xs text-slate-500 hover:text-slate-300"
            >
              <BookOpen className="w-3 h-3" /> {detail.name} documentation on Nango
            </a>
          )}
        </div>
      )}
    </SheetModal>
  );
};
