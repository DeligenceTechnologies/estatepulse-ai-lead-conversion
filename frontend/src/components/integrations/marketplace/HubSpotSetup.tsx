import React, { useCallback, useEffect, useState } from 'react';
import { Save, SlidersHorizontal } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection, type SetupResource } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { Select } from '../../common/Select';
import { Notice } from '../../calendar/shared/ui';

/** Lead fields HubSpot has no standard contact property for; the owner picks one of theirs. */
const TARGETS: { id: string; label: string; hint: string }[] = [
  { id: 'minBudget', label: 'Min budget', hint: 'Number property' },
  { id: 'maxBudget', label: 'Max budget', hint: 'Number property' },
  { id: 'bedrooms', label: 'Bedrooms', hint: 'Number property' },
  { id: 'timeline', label: 'Timeline', hint: 'Text property' },
  { id: 'location', label: 'Location', hint: 'Text property (default: city, state, country, read only)' },
  { id: 'motivation', label: 'Motivation / notes', hint: 'Text property (default: Message)' },
];

/**
 * Optional HubSpot setup: which contact properties hold budget, bedrooms,
 * timeline... Name, email and phone always sync with HubSpot's standard
 * properties. The server re-checks every property against the portal.
 */
export const HubSpotSetup: React.FC<{
  connection: IntegrationConnection;
  onSaved: (connection: IntegrationConnection) => void;
  onCancel: () => void;
}> = ({ connection, onSaved, onCancel }) => {
  const saved = ((connection.settings as { propertyMap?: Record<string, string> }).propertyMap ?? {}) as Record<string, string>;
  const [properties, setProperties] = useState<SetupResource[] | null>(null);
  const [map, setMap] = useState<Record<string, string>>(saved);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setProperties(null);
    try {
      setProperties(await integrationsApi.resources(connection.id, 'properties'));
    } catch (e) {
      setError(messageFor(e));
      setProperties([]);
    }
  }, [connection.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const propertyMap = Object.fromEntries(Object.entries(map).filter(([, v]) => v));
      const updated = await integrationsApi.updateSettings(connection.id, { propertyMap });
      toast.success('HubSpot field mapping saved. Contacts re-sync in a moment.');
      onSaved(updated);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const used = new Set(Object.values(map).filter(Boolean));
  const optionsFor = (target: string) =>
    (properties ?? []).filter((p) => ((p.detail as { targets?: string[] } | undefined)?.targets ?? []).includes(target));

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-4">
      <div className="flex items-center gap-2 text-xs font-bold text-white">
        <SlidersHorizontal className="w-4 h-4 text-slate-400" /> Map lead fields to HubSpot properties
      </div>
      <p className="text-2xs text-slate-500">
        Name, email and phone always sync with HubSpot’s standard properties. Pick your own properties for the rest, or leave them unmapped.
      </p>

      {error && (
        <Notice tone="error">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            {!properties?.length && (
              <Button size="sm" variant="danger-soft" onClick={() => void load()}>
                Retry
              </Button>
            )}
          </div>
        </Notice>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        {TARGETS.map((t) => (
          <div key={t.id}>
            <label className="block text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-1" htmlFor={`hs-${connection.id}-${t.id}`}>
              {t.label}
            </label>
            <Select
              id={`hs-${connection.id}-${t.id}`}
              value={map[t.id] ?? ''}
              disabled={!properties || saving}
              onChange={(e) => setMap((m) => ({ ...m, [t.id]: e.target.value }))}
            >
              <option value="">{properties ? 'Not mapped' : 'Loading properties…'}</option>
              {optionsFor(t.id).map((p) => (
                <option key={p.id} value={p.id} disabled={used.has(p.id) && map[t.id] !== p.id}>
                  {p.name}
                </option>
              ))}
            </Select>
            <p className="mt-1 text-2xs text-slate-600">{t.hint}</p>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" icon={<Save />} onClick={() => void save()} disabled={!properties || saving} loading={saving}>
          Save mapping
        </Button>
      </div>
    </div>
  );
};
