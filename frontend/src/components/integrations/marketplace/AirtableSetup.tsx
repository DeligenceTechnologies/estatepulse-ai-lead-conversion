import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Save, Table2 } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection, type SetupResource } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { Select } from '../../common/Select';
import { Notice } from '../../calendar/shared/ui';

/** Lead fields an Airtable column can fill, in the order the form shows them. Mirrors airtable.mapping.ts. */
const LEAD_FIELDS: { key: string; label: string; hint?: string }[] = [
  { key: 'fullName', label: 'Full name', hint: 'Split into first and last name' },
  { key: 'firstName', label: 'First name' },
  { key: 'lastName', label: 'Last name' },
  { key: 'email', label: 'Email' },
  { key: 'phone', label: 'Phone', hint: 'Needs the country code, e.g. +91' },
  { key: 'location', label: 'Location' },
  { key: 'timeline', label: 'Timeline' },
  { key: 'minBudget', label: 'Budget (min)' },
  { key: 'maxBudget', label: 'Budget (max)' },
  { key: 'bedrooms', label: 'Bedrooms' },
  { key: 'motivation', label: 'Notes' },
];

interface TableDetail {
  fields: { id: string; name: string; type: string }[];
  suggestedFieldMap: Record<string, string>;
  compatibility: Record<string, string[]>;
}

const tableDetail = (t: SetupResource | undefined): TableDetail | null => (t?.detail as TableDetail | undefined) ?? null;

/**
 * Airtable's setup: choose a base and table, check the field mapping, save.
 * Every choice is re-validated by the server against Airtable before it is
 * stored, so nothing here is trusted.
 */
export const AirtableSetup: React.FC<{
  connection: IntegrationConnection;
  onSaved: (connection: IntegrationConnection) => void;
  onCancel: () => void;
}> = ({ connection, onSaved, onCancel }) => {
  const saved = connection.settings as { baseId?: string; tableId?: string; fieldMap?: Record<string, string> };
  const [bases, setBases] = useState<SetupResource[] | null>(null);
  const [tables, setTables] = useState<SetupResource[] | null>(null);
  const [baseId, setBaseId] = useState(saved.baseId ?? '');
  const [tableId, setTableId] = useState(saved.tableId ?? '');
  const [fieldMap, setFieldMap] = useState<Record<string, string>>(saved.fieldMap ?? {});
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const loadBases = useCallback(async () => {
    setError(null);
    setBases(null);
    try {
      setBases(await integrationsApi.resources(connection.id, 'bases'));
    } catch (e) {
      setError(messageFor(e));
      setBases([]);
    }
  }, [connection.id]);

  useEffect(() => {
    void loadBases();
  }, [loadBases]);

  useEffect(() => {
    if (!baseId) {
      setTables(null);
      return;
    }
    let live = true;
    setTables(null);
    integrationsApi
      .resources(connection.id, 'tables', baseId)
      .then((t) => live && setTables(t))
      .catch((e) => {
        if (!live) return;
        setError(messageFor(e));
        setTables([]);
      });
    return () => {
      live = false;
    };
  }, [connection.id, baseId]);

  const table = useMemo(() => tables?.find((t) => t.id === tableId), [tables, tableId]);
  const detail = tableDetail(table);

  const chooseTable = (id: string) => {
    setTableId(id);
    const next = tableDetail(tables?.find((t) => t.id === id));
    // Keep the saved mapping for the saved table; a new table starts from the server's suggestion.
    setFieldMap(id === saved.tableId && saved.fieldMap ? saved.fieldMap : (next?.suggestedFieldMap ?? {}));
  };

  const canSave = Boolean(baseId && tableId && (fieldMap.email || fieldMap.phone)) && !saving;

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await integrationsApi.updateSettings(connection.id, { baseId, tableId, fieldMap });
      toast.success(updated.latestRun ? 'Saved. Importing leads from Airtable now.' : 'Saved.');
      onSaved(updated);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const label = 'block text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-1';

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-4">
      <div className="flex items-center gap-2 text-xs font-bold text-white">
        <Table2 className="w-4 h-4 text-slate-400" /> Choose where your leads are
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className={label} htmlFor={`base-${connection.id}`}>
            Base
          </label>
          <Select
            id={`base-${connection.id}`}
            value={baseId}
            disabled={!bases || saving}
            onChange={(e) => {
              setBaseId(e.target.value);
              setTableId('');
              setFieldMap({});
            }}
          >
            <option value="">{bases ? (bases.length ? 'Choose a base…' : 'No bases shared with this connection') : 'Loading bases…'}</option>
            {bases?.map((b) => (
              <option key={b.id} value={b.id}>
                {b.name}
              </option>
            ))}
          </Select>
        </div>
        <div>
          <label className={label} htmlFor={`table-${connection.id}`}>
            Table
          </label>
          <Select
            id={`table-${connection.id}`}
            value={tableId}
            disabled={!baseId || !tables || saving}
            onChange={(e) => chooseTable(e.target.value)}
          >
            <option value="">{!baseId ? 'Choose a base first' : tables ? 'Choose a table…' : 'Loading tables…'}</option>
            {tables?.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </Select>
        </div>
      </div>

      {detail && (
        <div className="space-y-2">
          <div className="text-2xs text-slate-500">
            We matched these columns automatically. Change any that are wrong; unmapped columns are kept on the lead as custom fields.
          </div>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {LEAD_FIELDS.map((f) => {
              const options = detail.fields.filter((col) => detail.compatibility[f.key]?.includes(col.id));
              return (
                <div key={f.key}>
                  <label className={label} htmlFor={`map-${connection.id}-${f.key}`} title={f.hint}>
                    {f.label}
                    {(f.key === 'email' || f.key === 'phone') && <span className="normal-case tracking-normal text-slate-600"> · email or phone required</span>}
                  </label>
                  <Select
                    id={`map-${connection.id}-${f.key}`}
                    value={fieldMap[f.key] ?? ''}
                    disabled={saving}
                    onChange={(e) =>
                      setFieldMap((m) => {
                        const next = { ...m };
                        if (e.target.value) next[f.key] = e.target.value;
                        else delete next[f.key];
                        return next;
                      })
                    }
                  >
                    <option value="">— Not mapped —</option>
                    {options.map((col) => (
                      <option key={col.id} value={col.id}>
                        {col.name}
                      </option>
                    ))}
                  </Select>
                </div>
              );
            })}
          </div>
        </div>
      )}

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" icon={<Save />} onClick={() => void save()} disabled={!canSave} loading={saving}>
          Save and import
        </Button>
      </div>
    </div>
  );
};
