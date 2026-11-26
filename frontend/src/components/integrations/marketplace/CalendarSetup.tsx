import React, { useCallback, useEffect, useState } from 'react';
import { CalendarCheck, Save } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection, type SetupResource } from '../../../utils/integrationsApi';
import { Button } from '../../common/Button';
import { Select } from '../../common/Select';
import { Notice } from '../../calendar/shared/ui';

/**
 * Setup of a scheduling calendar (Cal.com, Calendly): which calendar meetings
 * are booked into. Cal.com offers the account's own calendar or a team it is
 * an owner or admin of; Calendly its organization. Saving makes this account
 * the organization's calendar; the server re-checks the choice with the provider.
 */
export const CalendarSetup: React.FC<{
  connection: IntegrationConnection;
  onSaved: (connection: IntegrationConnection) => void;
  onCancel: () => void;
}> = ({ connection, onSaved, onCancel }) => {
  const saved = connection.settings as { workspaceId?: string };
  const [workspaces, setWorkspaces] = useState<SetupResource[] | null>(null);
  const [workspaceId, setWorkspaceId] = useState(saved.workspaceId ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    setWorkspaces(null);
    try {
      const list = await integrationsApi.resources(connection.id, 'workspaces');
      setWorkspaces(list);
      setWorkspaceId((current) => current || (list.length === 1 ? list[0].id : ''));
    } catch (e) {
      setError(messageFor(e));
      setWorkspaces([]);
    }
  }, [connection.id]);

  useEffect(() => {
    void load();
  }, [load]);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const updated = await integrationsApi.updateSettings(connection.id, { workspaceId });
      toast.success(`${connection.providerName} is now your scheduling calendar. Availability syncs in a moment.`);
      onSaved(updated);
    } catch (e) {
      setError(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  const chosen = workspaces?.find((w) => w.id === workspaceId);
  const chosenType = (chosen?.detail as { type?: string } | undefined)?.type;

  return (
    <div className="rounded-xl border border-slate-800 bg-slate-950/50 p-4 space-y-4">
      <div className="flex items-center gap-2 text-xs font-bold text-white">
        <CalendarCheck className="w-4 h-4 text-slate-400" /> Choose the calendar meetings are booked into
      </div>

      {error && (
        <Notice tone="error">
          <div className="flex items-center justify-between gap-3">
            <span>{error}</span>
            {!workspaces?.length && (
              <Button size="sm" variant="danger-soft" onClick={() => void load()}>
                Retry
              </Button>
            )}
          </div>
        </Notice>
      )}

      <div className="max-w-md">
        <label className="block text-2xs font-semibold uppercase tracking-wide text-slate-500 mb-1" htmlFor={`cal-ws-${connection.id}`}>
          Calendar
        </label>
        <Select id={`cal-ws-${connection.id}`} value={workspaceId} disabled={!workspaces || saving} onChange={(e) => setWorkspaceId(e.target.value)}>
          <option value="">{workspaces ? 'Choose a calendar…' : 'Loading calendars…'}</option>
          {workspaces?.map((w) => (
            <option key={w.id} value={w.id}>
              {(w.detail as { type?: string } | undefined)?.type === 'team' ? `Team: ${w.name}` : w.name}
            </option>
          ))}
        </Select>
        <p className="mt-1.5 text-2xs text-slate-500">
          {chosenType === 'team'
            ? 'Every member of this team can be booked. The connected account must be an owner or admin of the team.'
            : chosenType === 'organization'
              ? 'Every member of your Calendly organization can be booked. The connected account must be an owner or admin of it.'
              : 'The AI assistant and booking links use this calendar.'}{' '}
          One calendar is used at a time; choosing this one replaces the current calendar.
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
        <Button size="sm" icon={<Save />} onClick={() => void save()} disabled={!workspaceId || saving} loading={saving}>
          Use this calendar
        </Button>
      </div>
    </div>
  );
};
