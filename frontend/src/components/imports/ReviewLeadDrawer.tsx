import React, { useEffect, useState } from 'react';
import { AlertTriangle, Ban, FileX, PhoneOff, X } from 'lucide-react';
import { toast } from 'react-toastify';
import { LEADS_CHANGED_EVENT, leadsApi } from '../../api/client';
import { messageFor } from '../../lib/api';
import { editCrmRow, editReviewRow, type EditableField, type ImportKind, type ReviewItem } from '../../utils/googleSheetsApi';
import { TimezoneSelect } from '../common/TimezoneSelect';
import { SourceBadge } from './ImportHistoryModal';

/** What a row's source is called when it is named in full. */
export const KIND_NAME: Record<ImportKind, string> = {
  google_sheets: 'Google Sheet',
  file_upload: 'Uploaded file',
  hubspot: 'HubSpot',
};

/** Where the owner has to go to change anything shown here. */
const FIX_AT: Record<ImportKind, string> = {
  google_sheets: 'Edit the row in the sheet and sync again.',
  file_upload: 'Fix the row in the file and upload it again.',
  hubspot: 'Change the record in HubSpot and sync again.',
};

const money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });

/** Field names an import kept as extra columns are shown as they were written, tidied a little. */
const prettify = (key: string): string => key.replace(/[_-]+/g, ' ').replace(/^./, (c) => c.toUpperCase());

const show = (v: unknown): string => {
  if (v === null || v === undefined || v === '') return '—';
  return typeof v === 'object' ? JSON.stringify(v) : String(v);
};

const Row: React.FC<{ label: string; value: React.ReactNode; tone?: 'plain' | 'warn' }> = ({ label, value, tone = 'plain' }) => (
  <div className="flex items-start gap-3 px-3.5 py-2.5">
    <dt className="w-28 shrink-0 pt-0.5 text-2xs font-semibold uppercase tracking-wider text-slate-500">{label}</dt>
    <dd className={`min-w-0 flex-1 break-words ${tone === 'warn' ? 'text-amber-300' : 'text-slate-200'}`}>{value}</dd>
  </div>
);

const INPUT =
  'w-full bg-slate-950 border border-slate-800 rounded-lg px-2.5 py-1.5 text-xs text-white focus:outline-none focus:border-emerald-600 disabled:opacity-40';

/** One editable line of the Contact section: an input where the sheet has a column for it, the value otherwise. */
const EditRow: React.FC<{
  label: string;
  field: EditableField;
  fields: EditableField[];
  value: string;
  onChange: (v: string) => void;
  disabled: boolean;
  type?: string;
  placeholder?: string;
  tone?: 'plain' | 'warn';
}> = ({ label, field, fields, value, onChange, disabled, type = 'text', placeholder, tone }) =>
  fields.includes(field) ? (
    <Row
      label={label}
      value={<input type={type} value={value} placeholder={placeholder} onChange={(e) => onChange(e.target.value)} disabled={disabled} className={INPUT} aria-label={label} />}
    />
  ) : (
    <Row label={label} value={<span title="The sheet has no column for this">{show(value)}</span>} tone={tone} />
  );

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="px-5 py-4">
    <h4 className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{title}</h4>
    <dl className="rounded-xl border border-slate-800 bg-slate-900/60 divide-y divide-slate-800/70 text-xs">{children}</dl>
  </div>
);

/**
 * Everything one row brought in, in a panel sliding in from the right — the same panel the team
 * screen uses for a member. An imported lead is owned by the sheet, file or CRM it came from, so
 * it is read-only here, except a Google Sheets row synced by an ID column (`item.edit`): its name,
 * phone and email are written back into the sheet and the sheet is re-read, so the two never
 * disagree. What is wrong is named here rather than left as an icon to hover.
 */
export const ReviewLeadDrawer: React.FC<{ item: ReviewItem; warnings: string[]; onClose: () => void; onSaved?: () => void }> = ({
  item,
  warnings,
  onClose,
  onSaved,
}) => {
  const lead = item.lead;
  const kind = item.source?.kind ?? 'google_sheets';
  const editable = Boolean(item.edit && lead);
  const fields = item.edit?.fields ?? [];
  const toCrm = item.edit?.via === 'crm';
  // Where a save goes, as the owner would say it.
  const target = toCrm ? KIND_NAME[kind] : 'the sheet';

  const initial = {
    firstName: lead?.firstName ?? '',
    lastName: lead?.lastName ?? '',
    phone: lead?.phone ?? '',
    email: lead?.email ?? '',
    timezone: lead?.timezone ?? '',
  };
  const [form, setForm] = useState(initial);
  const [saving, setSaving] = useState(false);
  const set = (key: keyof typeof initial) => (v: string) => setForm((f) => ({ ...f, [key]: v }));
  const dirty = (Object.keys(initial) as (keyof typeof initial)[]).filter((k) => form[k].trim() !== initial[k]);

  const save = async () => {
    if (!lead || dirty.length === 0) return;
    setSaving(true);
    try {
      // What the sheet has a column for goes into the sheet; a zone with no column is the lead's own.
      const TARGET = { firstName: 'first_name', lastName: 'last_name', phone: 'phone', email: 'email', timezone: 'timezone' } as const;
      const toSheet = Object.fromEntries(dirty.filter((k) => fields.includes(TARGET[k])).map((k) => [k, form[k].trim()]));
      let synced = true;
      if (Object.keys(toSheet).length > 0) {
        // A CRM is re-read in the background, so the lead follows a moment later; a sheet is re-read before this answers.
        synced = toCrm ? false : (await editReviewRow(item.rowId, toSheet)).synced;
        if (toCrm) await editCrmRow('hubspot', item.rowId, toSheet);
      }
      if (dirty.includes('timezone') && !fields.includes('timezone')) await leadsApi.setTimezone(lead.id, form.timezone || null);
      const wrote = Object.keys(toSheet).length > 0;
      toast.success(
        !wrote ? 'Time zone saved.' : synced ? `Saved, and written to ${target}.` : `Written to ${target}. The lead updates in a moment.`,
      );
      window.dispatchEvent(new Event(LEADS_CHANGED_EVENT));
      onSaved?.();
    } catch (err) {
      toast.error(messageFor(err));
    } finally {
      setSaving(false);
    }
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const name = [lead?.firstName, lead?.lastName].filter(Boolean).join(' ') || 'Unnamed lead';
  const extras = Object.entries(lead?.customFields ?? {});

  // Everything an owner should know before approving, once each. The lead's own warnings already
  // cover its data (a bad phone, a bad email, a do-not-contact note), so only what they cannot
  // say — the row gone from the source, no number at all — is worked out here.
  const problems: { icon: React.ReactNode; text: string }[] = [
    ...(item.missing
      ? [{
          icon: <FileX className="w-3.5 h-3.5" />,
          text: kind === 'hubspot' ? 'No longer in HubSpot — reject it if it should not be worked' : 'No longer in the source — reject it if it should not be worked',
        }]
      : []),
    ...(lead && !lead.phone
      ? [{ icon: <PhoneOff className="w-3.5 h-3.5" />, text: 'No phone number — this lead cannot be called' }]
      : []),
    ...warnings.map((w) => ({ icon: lead?.dncStatus && w.includes('opted out') ? <Ban className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />, text: w })),
  ];

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby="review-lead-title">
      <div className="absolute inset-0 bg-slate-950/80 animate-fade-in" onClick={onClose} />

      <aside className="relative w-full sm:max-w-lg h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col animate-slide-in-right">
        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar">
          {/* Who the row is, and where it came from */}
          <div className="relative border-b border-slate-800 bg-slate-950/40">
            <button
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="absolute top-3 right-3 w-8 h-8 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 flex items-center justify-center cursor-pointer transition-colors"
            >
              <X className="w-4 h-4" />
            </button>

            <div className="px-5 pt-6 pb-5 pr-12">
              <h3 id="review-lead-title" className="text-lg font-bold text-white tracking-tight truncate">
                {name}
              </h3>
              <div className="mt-2 flex items-center gap-2 text-2xs text-slate-400 flex-wrap">
                <SourceBadge kind={kind} />
                <span className="truncate">{item.source?.name ?? '—'}</span>
                {kind !== 'hubspot' && <span>· row {item.rowNumber}</span>}
                <span>· imported {new Date(item.importedAt).toLocaleDateString()}</span>
              </div>
            </div>
          </div>

          {problems.length > 0 && (
            <div className="px-5 pt-4">
              <div className="rounded-xl border border-amber-500/30 bg-amber-500/10 p-3 space-y-2">
                {problems.map((p) => (
                  <div key={p.text} className="flex items-start gap-2 text-2xs text-amber-200 leading-relaxed">
                    <span className="text-amber-400 shrink-0 mt-0.5">{p.icon}</span>
                    <span>{p.text}</span>
                  </div>
                ))}
                <p className="text-2xs text-amber-200/80 border-t border-amber-500/20 pt-2 leading-relaxed">
                  {editable
                    ? toCrm
                      ? `Fix the contact details below: saving updates the contact in ${target}, then re-reads it. Anything else is changed in ${target} itself.`
                      : `Fix the contact details below: saving writes them into row ${item.rowNumber} of the sheet, then re-reads it. Anything else is changed in the sheet itself.`
                    : `These details cannot be changed here — they are read from the source every sync. ${FIX_AT[kind]}`}
                </p>
              </div>
            </div>
          )}

          {editable ? (
            <Section title={`Contact — saved to ${target}`}>
              <EditRow label="First name" field="first_name" fields={fields} value={form.firstName} onChange={set('firstName')} disabled={saving} />
              <EditRow label="Last name" field="last_name" fields={fields} value={form.lastName} onChange={set('lastName')} disabled={saving} />
              <EditRow
                label="Phone"
                field="phone"
                fields={fields}
                value={form.phone}
                onChange={set('phone')}
                disabled={saving}
                type="tel"
                placeholder="+1 415 555 0100"
                tone={lead?.phone && !lead.phoneValid ? 'warn' : 'plain'}
              />
              <EditRow label="Email" field="email" fields={fields} value={form.email} onChange={set('email')} disabled={saving} type="email" />
              <Row
                label="Time zone"
                value={
                  <>
                    <TimezoneSelect
                      id="review-lead-timezone"
                      value={form.timezone}
                      onChange={set('timezone')}
                      disabled={saving}
                      placeholder="Worked out from the phone number"
                      className={INPUT}
                    />
                    {!fields.includes('timezone') && (
                      <p className="mt-1 text-2xs text-slate-500">
                        Kept in EstatePulse only — {toCrm ? target : 'the sheet'} has no time zone {toCrm ? 'field we write to' : 'column'}.
                      </p>
                    )}
                  </>
                }
              />
            </Section>
          ) : (
            <Section title="Contact">
              <Row label="First name" value={show(lead?.firstName)} />
              <Row label="Last name" value={show(lead?.lastName)} />
              <Row
                label="Phone"
                value={show(lead?.phone)}
                tone={lead?.phone && !lead.phoneValid ? 'warn' : 'plain'}
              />
              <Row label="Email" value={show(lead?.email)} tone={lead?.email && !lead.emailValid ? 'warn' : 'plain'} />
              <Row
                label="Time zone"
                value={lead?.timezone ?? <span className="text-slate-500">Worked out from the phone number</span>}
              />
            </Section>
          )}

          <Section title="What they want">
            <Row label="Location" value={show(lead?.location)} />
            <Row label="Timeline" value={show(lead?.timeline)} />
            <Row label="Budget min" value={lead?.minBudget === null || lead?.minBudget === undefined ? '—' : money.format(lead.minBudget)} />
            <Row label="Budget max" value={lead?.maxBudget === null || lead?.maxBudget === undefined ? '—' : money.format(lead.maxBudget)} />
            <Row label="Bedrooms" value={show(lead?.bedrooms)} />
            <Row label="Notes" value={show(lead?.motivation)} />
          </Section>

          {extras.length > 0 && (
            <Section title="Extra fields">
              {extras.map(([key, value]) => (
                <Row key={key} label={prettify(key)} value={show(value)} />
              ))}
            </Section>
          )}
        </div>

        <div className="border-t border-slate-800 px-5 py-3 bg-slate-950/40 flex gap-2">
          <button
            type="button"
            onClick={onClose}
            className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            {editable ? 'Cancel' : 'Close'}
          </button>
          {editable && (
            <button
              type="button"
              onClick={() => void save()}
              disabled={saving || dirty.length === 0}
              className="flex-1 px-4 py-2 bg-emerald-600 hover:bg-emerald-500 text-on-accent rounded-lg text-xs font-semibold transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {saving ? 'Saving…' : `Save to ${toCrm ? target : 'sheet'}`}
            </button>
          )}
        </div>
      </aside>
    </div>
  );
};
