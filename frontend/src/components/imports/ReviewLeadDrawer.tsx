import React, { useEffect } from 'react';
import { AlertTriangle, Ban, FileX, PhoneOff, X } from 'lucide-react';
import type { ImportKind, ReviewItem } from '../../utils/googleSheetsApi';
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

const Section: React.FC<{ title: string; children: React.ReactNode }> = ({ title, children }) => (
  <div className="px-5 py-4">
    <h4 className="text-2xs font-semibold uppercase tracking-wider text-slate-500 mb-2">{title}</h4>
    <dl className="rounded-xl border border-slate-800 bg-slate-900/60 divide-y divide-slate-800/70 text-xs">{children}</dl>
  </div>
);

/**
 * Everything one row brought in, in a panel sliding in from the right — the same panel the team
 * screen uses for a member. Read-only on purpose: an imported lead is owned by the sheet, file
 * or CRM it came from, so anything wrong is corrected there and synced again. What is wrong is
 * named here rather than left as an icon to hover.
 */
export const ReviewLeadDrawer: React.FC<{ item: ReviewItem; warnings: string[]; onClose: () => void }> = ({
  item,
  warnings,
  onClose,
}) => {
  const lead = item.lead;
  const kind = item.source?.kind ?? 'google_sheets';

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
                  These details cannot be changed here — they are read from the source every sync.{' '}
                  {FIX_AT[kind]}
                </p>
              </div>
            </div>
          )}

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

        <div className="border-t border-slate-800 px-5 py-3 bg-slate-950/40">
          <button
            type="button"
            onClick={onClose}
            className="w-full px-4 py-2 bg-slate-800 hover:bg-slate-700 text-slate-200 rounded-lg text-xs font-semibold transition-colors cursor-pointer"
          >
            Close
          </button>
        </div>
      </aside>
    </div>
  );
};
