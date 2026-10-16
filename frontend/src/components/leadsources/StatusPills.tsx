import React from 'react';
import {
  CheckCircle2,
  PauseCircle,
  Radio,
  SlidersHorizontal,
  Unplug,
  Webhook,
  type LucideIcon,
} from 'lucide-react';
import type { LeadSourceConfig } from '../../api/client';

/**
 * Status values arrive UPPERCASE from the server (see server/src/common/domain.ts).
 * Normalizing here means a backend that ever lowercases them does not silently
 * blank every badge.
 */
const norm = (s: string | null | undefined) => (s ?? '').toUpperCase();

interface Tone {
  cls: string;
  label: string;
  Icon: LucideIcon;
  pulse?: boolean;
  title?: string;
}

/**
 * Derived from the PAIR of ingest and mapping status, not from either alone.
 *
 * The distinction worth keeping: a source that is mapped and waiting is armed
 * ("listening"), while one whose secret was never pasted anywhere is not
 * ("needs setup"). Both sit at AWAITING_FIRST_EVENT, and conflating them is
 * what makes a connected form look broken.
 */
export function sourceTone(s: LeadSourceConfig): Tone {
  const ingest = norm(s.ingestStatus);
  const mapping = norm(s.mappingStatus);
  const remote = norm(s.remoteState);

  if (remote === 'UNINSTALLED' || remote === 'ORPHANED') {
    return {
      cls: 'bg-rose-500/20 text-rose-300 border-rose-500/40',
      label: 'webhook missing',
      Icon: Unplug,
      title: 'The webhook is no longer on the form. Submissions since then were never sent to us.',
    };
  }
  if (remote === 'ERROR' || remote === 'DRIFTED') {
    return {
      cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      label: 'out of sync',
      Icon: Unplug,
      title: s.remoteErrorMessage ?? 'We could not confirm the webhook on the provider.',
    };
  }
  if (ingest === 'PAUSED' || s.isActive === false) {
    return { cls: 'bg-slate-800 text-slate-400 border-slate-700', label: 'paused', Icon: PauseCircle };
  }
  // A custom webhook is mapped by hand, so its waiting states say what is waited for.
  if (norm(s.provider) === 'CUSTOM') {
    if (ingest === 'AWAITING_FIRST_EVENT') {
      return {
        cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
        label: 'waiting for payload',
        Icon: Radio,
        pulse: true,
        title: 'Nothing has been posted to the webhook URL yet.',
      };
    }
    if (ingest === 'NEEDS_MAPPING') {
      return mapping === 'CONFIGURED'
        ? {
            cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
            label: 'ready to switch on',
            Icon: SlidersHorizontal,
            title: 'Mapped. Switch it on to start creating leads; deliveries are held until then.',
          }
        : {
            cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
            label: 'needs mapping',
            Icon: SlidersHorizontal,
            title: 'A payload arrived. Map its fields to lead fields.',
          };
    }
  }
  if (ingest === 'NEEDS_MAPPING' || mapping === 'NEEDS_REVIEW') {
    return {
      cls: 'bg-amber-500/20 text-amber-300 border-amber-500/40',
      label: 'needs review',
      Icon: SlidersHorizontal,
      title: 'Fields were mapped automatically and are already in use. Worth a look.',
    };
  }
  if (ingest === 'ACTIVE') {
    return { cls: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40', label: 'active', Icon: CheckCircle2 };
  }
  if (ingest === 'AWAITING_FIRST_EVENT' && mapping === 'CONFIGURED') {
    return {
      cls: 'bg-cyan-500/15 text-cyan-300 border-cyan-500/30',
      label: 'listening',
      Icon: Radio,
      pulse: true,
      title: 'Mapped and waiting for its first submission.',
    };
  }
  if (ingest === 'AWAITING_FIRST_EVENT') {
    return {
      cls: 'bg-slate-800 text-slate-400 border-slate-700',
      label: 'needs setup',
      Icon: Webhook,
      title: 'No submission has arrived yet.',
    };
  }
  return {
    cls: 'bg-slate-800 text-slate-400 border-slate-700',
    label: ingest.toLowerCase().replace(/_/g, ' ') || 'unknown',
    Icon: Webhook,
  };
}

const PILL = 'text-2xs font-bold uppercase px-2 py-0.5 rounded-full border flex items-center gap-1';

export const SourceStatusPill: React.FC<{ source: LeadSourceConfig }> = ({ source }) => {
  const t = sourceTone(source);
  return (
    <span className={`${PILL} ${t.cls}`} title={t.title}>
      <t.Icon className={`w-3 h-3 ${t.pulse ? 'animate-pulse' : ''}`} />
      {t.label}
    </span>
  );
};

/** How this source was connected — the thing that decides what we can repair. */
export const ConnectionPill: React.FC<{ source: LeadSourceConfig }> = ({ source }) => {
  if (norm(source.connectionMethod) !== 'API') {
    return (
      <span
        className={`${PILL} bg-slate-800 text-slate-400 border-slate-700`}
        title="Set up by pasting the webhook URL by hand. We hold no credential, so we cannot repair or remove it for you."
      >
        manual
      </span>
    );
  }
  return (
    <span
      className={`${PILL} bg-cyan-500/15 text-cyan-300 border-cyan-500/30`}
      title="We installed this webhook with your API key, so we can repair, pause and remove it."
    >
      <Radio className="w-3 h-3" />
      {(source.provider ?? 'api').toLowerCase()}
    </span>
  );
};
