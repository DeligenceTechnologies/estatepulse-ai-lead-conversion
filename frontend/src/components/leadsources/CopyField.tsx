import React, { useState } from 'react';
import { Check, Copy } from 'lucide-react';
import { toast } from 'react-toastify';
import { Button } from '../common/Button';

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
      <div className="text-xs text-slate-400 font-medium">{label}</div>
      <div className="flex items-stretch gap-2">
        <div
          className={`flex-1 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-xs text-cyan-300 overflow-x-auto whitespace-nowrap ${
            mono ? 'font-mono' : ''
          }`}
        >
          {value}
        </div>
        <Button
          variant="secondary"
          className="h-auto! self-stretch"
          onClick={() => {
            navigator.clipboard.writeText(value).catch(() => toast.error('Could not copy — select the text instead.'));
            setCopied(true);
            setTimeout(() => setCopied(false), 1800);
          }}
          icon={copied ? <Check className="text-emerald-400" /> : <Copy />}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
      </div>
    </div>
  );
};
