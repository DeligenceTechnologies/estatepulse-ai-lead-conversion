import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';

/**
 * A read-only value with a copy button.
 *
 * Extracted from LeadSourcesView so the connect flow can reuse it for the
 * webhook URL it shows under "troubleshooting", rather than growing a second
 * copy-to-clipboard idiom that behaves slightly differently.
 */
export const CopyField: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono = true,
}) => {
  const [copied, setCopied] = useState(false);
  return (
    <div className="space-y-1">
      <div className="text-[11px] text-slate-400 font-medium">{label}</div>
      <div className="flex items-stretch gap-2">
        <div
          className={`flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-cyan-300 overflow-x-auto whitespace-nowrap ${
            mono ? 'font-mono' : ''
          }`}
        >
          {value}
        </div>
        <button
          onClick={() => {
            navigator.clipboard.writeText(value);
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          className="px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-emerald-400" /> : <Copy className="w-3.5 h-3.5" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
    </div>
  );
};
