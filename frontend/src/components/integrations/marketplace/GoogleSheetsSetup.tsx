import React, { useEffect, useMemo, useState } from 'react';
import { Save, Sheet } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection, type SetupResource } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { Select } from '../../common/Select';
import { Notice } from '../../calendar/shared/ui';
import { LEAD_FIELDS } from './TallySetup';

/** A pasted link or a bare id -> the spreadsheet id. Mirrors spreadsheetIdFrom in google-sheets.adapter.ts. */
const spreadsheetIdFrom = (input: string): string | null => {
  const trimmed = input.trim();
  const id = /\/spreadsheets\/d\/([A-Za-z0-9_-]+)/.exec(trimmed)?.[1] ?? trimmed;
  return /^[A-Za-z0-9_-]{20,100}$/.test(id) ? id : null;
};

const suggestedMap = (columns: SetupResource[]): Record<string, string> => {
  const map: Record<string, string> = {};
  for (const c of columns) {
    const target = (c.detail as { suggested?: string | null } | undefined)?.suggested;
    if (target) map[target] = c.id;
  }
  return map;
};

/**
 * Google Sheets setup: paste the sheet link, choose the tab, check which
 * column fills which lead field, save. Row 1 is the header. Every choice is
 * re-validated by the server against Google before it is stored.
 */
export const GoogleSheetsSetup: React.FC<{
  connection: IntegrationConnection;
  onSaved: (connection: IntegrationConnection) => void;
  onCancel: () => void;
}> = ({ connection, onSaved, onCancel }) => {
  const saved = connection.settings as { spreadsheetId?: string; sheetId?: number; fieldMap?: Record<string, string> };
  const [link, setLink] = useState(saved.spreadsheetId ? `https://docs.google.com/spreadsheets/d/${saved.spreadsheetId}` : '');
  const [spreadsheetId, setSpreadsheetId] = useState<string | null>(saved.spreadsheetId ?? null);
  const [spreadsheetName, setSpreadsheetName] = useState<string | null>(null);
  const [tabs, setTabs] = useState<SetupResource[] | null>(null);
  const [sheetId, setSheetId] = useState(saved.sheetId !== undefined ? String(saved.sheetId) : '');
  const [columns, setColumns] = useState<SetupResource[] | null>(null);
  const [fieldMap, setFieldMap] = useState<Record<string, string>>(saved.fieldMap ?? {});
  const [error, setError] = useState<string | null>(null);
  const [loadingTabs, setLoadingTabs] = useState(false);
  const [saving, setSaving] = useState(false);

  const loadTabs = async (id: string) => {
    setError(null);
    setLoadingTabs(true);
    setTabs(null);
    try {
      const list = await integrationsApi.resources(connection.id, 'tabs', id);
      setTabs(list);
      setSpreadsheetId(id);
      setSpreadsheetName((list[0]?.detail as { spreadsheetName?: string } | undefined)?.spreadsheetName ?? null);
      // Keep the saved tab when it still exists; one tab needs no choosing.
      setSheetId((current) => (list.some((t) => t.id === current) ? current : list.length === 1 ? list[0].id : ''));
    } catch (e) {
      setError(messageFor(e));
      setSpreadsheetId(null);
    } finally {
      setLoadingTabs(false);
    }
  };

  useEffect(() => {
    if (saved.spreadsheetId) void loadTabs(saved.spreadsheetId);
    // The saved setup does not change while this panel is open.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id]);

  useEffect(() => {
    if (!spreadsheetId || sheetId === '') {
      setColumns(null);
      return;
    }
    let live = true;
    setColumns(null);
    integrationsApi
      .resources(connection.id, 'columns', `${spreadsheetId}.${sheetId}`)
      .then((c) => {
        if (!live) return;
        setColumns(c);
        const same = spreadsheetId === saved.spreadsheetId && String(saved.sheetId) === sheetId && saved.fieldMap;
        setFieldMap(same ? saved.fieldMap! : suggestedMap(c));
      })
      .catch((e) => {
        if (!live) return;
        setError(messageFor(e));
        setColumns([]);
      });
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [connection.id, spreadsheetId, sheetId]);

  const taken = useMemo(() => new Map(Object.entries(fieldMap).map(([target, id]) => [id, target])), [fieldMap]);
  const canSave = Boolean(spreadsheetId && sheetId !== '' && columns?.length && (fieldMap.email || fieldMap.phone)) && !saving;

  const submitLink = () => {
    const id = spreadsheetIdFrom(link);
    if (!id) {
      setError('That does not look like a Google Sheets link. Copy it from the browser address bar while the sheet is open.');
      return;
    }
    if (id !== spreadsheetId) {
      setSheetId('');
      setFieldMap({});
    }
    void loadTabs(id);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await integrationsApi.updateSettings(connection.id, { spreadsheetId, sheetId: Number(sheetId), fieldMap });
      toast.success(updated.latestRun ? 'Saved. Importing rows from Google Sheets now.' : 'Saved.');
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
        <Sheet className="w-4 h-4 text-slate-400" /> Choose the sheet your leads are in
      </div>

      {error && <Notice tone="error">{error}</Notice>}

      <div>
        <label className={label} htmlFor={`sheet-link-${connection.id}`}>
          Google Sheet link
        </label>
        <div className="flex flex-col gap-2 sm:flex-row">
          <input
            id={`sheet-link-${connection.id}`}
            value={link}
            disabled={saving}
            onChange={(e) => setLink(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submitLink();
            }}
            placeholder="https://docs.google.com/spreadsheets/d/…"
            className="flex-1 min-w-0 bg-slate-900 border border-slate-700 rounded-lg px-3 py-2 text-xs text-white focus:outline-none focus:border-emerald-500"
          />
          <Button size="sm" variant="ghost" onClick={submitLink} loading={loadingTabs} disabled={!link.trim() || saving}>
            Open sheet
          </Button>
        </div>
        <div className="mt-1 text-2xs text-slate-500">The Google account you connected must be able to open this sheet.</div>
      </div>

      {tabs && (
        <div>
          <label className={label} htmlFor={`sheet-tab-${connection.id}`}>
            Tab{spreadsheetName ? ` in “${spreadsheetName}”` : ''}
          </label>
          <Select
            id={`sheet-tab-${connection.id}`}
            value={sheetId}
            disabled={saving}
            onChange={(e) => {
              setSheetId(e.target.value);
              setFieldMap({});
            }}
          >
            <option value="">{tabs.length ? 'Choose a tab…' : 'This spreadsheet has no tabs with cells'}</option>
            {tabs.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {(t.detail as { hidden?: boolean } | undefined)?.hidden ? ' (hidden)' : ''}
              </option>
            ))}
          </Select>
        </div>
      )}

      {sheetId !== '' && spreadsheetId && !columns && <div className="text-2xs text-slate-500">Reading the header row…</div>}

      {columns && columns.length === 0 && !error && (
        <Notice tone="warning">Row 1 of this tab is empty. Put the column names (Name, Email, Phone…) in row 1, then open the sheet again.</Notice>
      )}

      {columns && columns.length > 0 && (
        <div className="space-y-2">
          <div className="text-2xs text-slate-500">
            We matched these columns from row 1. Change any that are wrong; unmapped columns are kept on the lead as custom fields. Rows without an email or phone
            are skipped.
          </div>
          <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
            {LEAD_FIELDS.map((f) => (
              <div key={f.key}>
                <label className={label} htmlFor={`sheet-map-${connection.id}-${f.key}`} title={f.hint}>
                  {f.label}
                  {(f.key === 'email' || f.key === 'phone') && <span className="normal-case tracking-normal text-slate-600"> · email or phone required</span>}
                </label>
                <Select
                  id={`sheet-map-${connection.id}-${f.key}`}
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
                  {columns.map((c) => {
                    const other = taken.get(c.id);
                    return (
                      <option key={c.id} value={c.id} disabled={Boolean(other && other !== f.key)}>
                        {c.name}
                        {other && other !== f.key ? ' (already mapped)' : ''}
                      </option>
                    );
                  })}
                </Select>
              </div>
            ))}
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
