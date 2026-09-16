import React, { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';

/**
 * The first credential input in this app, so it sets the precedent.
 *
 * Choices that are not obvious:
 *
 *  - `type="password"` WITH a reveal toggle, not permanent masking. A key
 *    pasted short is otherwise undebuggable, and the person entering it is
 *    holding a value they copied seconds ago.
 *  - `.trim()` on change, not on submit. Copying from a provider's "shown once"
 *    dialog routinely picks up a trailing newline, and trimming at the edge
 *    means the value shown is the value sent.
 *  - `data-1p-ignore` / `data-lpignore` so password managers do not offer to
 *    save a value that is not a credential for THIS site.
 *  - No format validation. A `tly-` regex in the browser means a provider
 *    changing its prefix bricks the field until we redeploy; the server
 *    validates by actually calling the provider, which is the only check that
 *    means anything.
 */
export const CredentialField: React.FC<{
  label: string;
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  disabled?: boolean;
  placeholder?: string;
}> = ({ label, value, onChange, onSubmit, disabled, placeholder }) => {
  const [reveal, setReveal] = useState(false);

  return (
    <div className="space-y-1">
      <div className="text-[11px] text-slate-400 font-medium">{label}</div>
      <div className="flex items-stretch gap-2">
        <input
          autoFocus
          type={reveal ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value.trim())}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !disabled) onSubmit();
          }}
          placeholder={placeholder ?? 'tly-••••••••••••••••••••'}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          disabled={disabled}
          className="flex-1 min-w-0 bg-slate-950 border border-slate-800 rounded-lg px-3 py-2 text-sm text-white font-mono tracking-wider focus:outline-none focus:border-emerald-500 disabled:opacity-50"
        />
        <button
          type="button"
          onClick={() => setReveal((r) => !r)}
          className="px-3 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer shrink-0"
        >
          {reveal ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
          {reveal ? 'Hide' : 'Show'}
        </button>
      </div>
    </div>
  );
};
