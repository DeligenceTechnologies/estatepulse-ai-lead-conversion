import React, { useState } from 'react';
import { AlertTriangle, ArrowLeftRight } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../../lib/api';
import { integrationsApi, type IntegrationConnection } from '../../../utils/integrationsApi';
import { Switch } from '../../views/VoicemailCard';
import { relativeTime } from './parts';

/**
 * Two-way sync of one account: lead changes made in EstatePulse are written
 * back to the record the lead came from. When both sides changed the same
 * field, EstatePulse's value is kept.
 */
export const TwoWaySyncPanel: React.FC<{ connection: IntegrationConnection; canEdit: boolean; onChanged: () => void }> = ({
  connection: c,
  canEdit,
  onChanged,
}) => {
  const [saving, setSaving] = useState(false);
  const tw = c.twoWay;
  if (!tw || c.status === 'disconnected') return null;

  const set = async (enabled: boolean) => {
    setSaving(true);
    try {
      await integrationsApi.setWriteBack(c.id, enabled);
      toast.success(enabled ? `Two-way sync is on. Lead changes go back to ${c.providerName}.` : `Two-way sync is off. ${c.providerName} still imports into EstatePulse.`);
      onChanged();
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="rounded-lg border border-slate-800 bg-slate-900/40 px-3 py-2.5 space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-2xs text-slate-400 min-w-0">
          <ArrowLeftRight className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <span>
            {tw.enabled
              ? `Changes made in EstatePulse are written back to ${c.providerName}.${tw.lastPushedAt ? ` Last write ${relativeTime(tw.lastPushedAt)}.` : ''}`
              : `Only ${c.providerName} → EstatePulse. Turn on to write lead changes back.`}
          </span>
        </div>
        {canEdit ? (
          <Switch id={`two-way-${c.id}`} on={tw.enabled && !tw.error} disabled={saving} onChange={(on) => void set(on)} label="Two-way sync" />
        ) : (
          <span className="text-2xs font-semibold text-slate-300">Two-way sync {tw.enabled ? 'on' : 'off'}</span>
        )}
      </div>

      {tw.enabled && tw.error && (
        <div className="flex items-start gap-2 text-2xs text-amber-200">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
          <span>
            Paused: {tw.error}
            {canEdit && ' After reconnecting, it resumes on its own (or switch it on again).'}
          </span>
        </div>
      )}

      {tw.enabled && !tw.error && tw.failedRecords > 0 && (
        <p className="text-2xs text-amber-200/90">
          {tw.failedRecords} lead{tw.failedRecords === 1 ? '' : 's'} could not be written back (record deleted, or a value {c.providerName} refused). Those
          changes stay in EstatePulse and are retried when the lead changes again.
        </p>
      )}
      {tw.enabled && <p className="text-2xs text-slate-500">If a field changed in both places, the EstatePulse value is kept.</p>}
    </div>
  );
};
