import React, { useEffect, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';

const iconButton =
  'p-1.5 rounded-lg text-slate-500 hover:text-slate-200 hover:bg-slate-800 transition-colors shrink-0 cursor-pointer focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500';

/** Copies `url`; ticks for a moment once it is on the clipboard. */
export const CopyLink: React.FC<{ url: string; title: string }> = ({ url, title }) => {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1500);
    return () => window.clearTimeout(timer);
  }, [copied]);

  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(url).then(() => setCopied(true), () => undefined);
      }}
      title={copied ? 'Copied' : title}
      aria-label={title}
      className={iconButton}
    >
      {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
    </button>
  );
};

export const OpenLink: React.FC<{ url: string; title: string }> = ({ url, title }) => (
  <a href={url} target="_blank" rel="noopener noreferrer" title={title} aria-label={title} className={iconButton}>
    <ExternalLink className="w-3.5 h-3.5" />
  </a>
);
