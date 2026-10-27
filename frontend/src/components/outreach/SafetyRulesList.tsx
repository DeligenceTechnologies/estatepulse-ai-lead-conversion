import React from 'react';
import { Lock } from 'lucide-react';
import type { SafetyRule } from '../../utils/strategiesApi';

interface Props {
  rules: SafetyRule[];
  scope: 'strategy' | 'sequence';
}

/** The built-in rules, read-only, as the server enforces them: a step never goes, or waits, while one holds. Folded behind a summary line. */
export const SafetyRulesList: React.FC<Props> = ({ rules, scope }) => {
  const mine = rules.filter((r) => r.appliesTo.includes(scope));
  const never = mine.filter((r) => r.kind === 'never_sends');
  const waits = mine.filter((r) => r.kind === 'waits');
  if (!mine.length) return null;

  return (
    <details className="rounded-lg border border-slate-800 bg-slate-950/40 px-2.5 py-1.5 text-2xs text-slate-400">
      <summary className="cursor-pointer list-none">
        <span className="flex items-center gap-1.5 font-semibold text-slate-300">
          <Lock className="w-3 h-3" /> Never sends if (built in, always on)
        </span>
      </summary>
      <div className="mt-1.5 space-y-1.5">
        <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
          {never.map((r) => (
            <li key={r.id}>• {r.label}</li>
          ))}
        </ul>
        {waits.length > 0 && (
          <>
            <div className="flex items-center gap-1.5 font-semibold text-slate-300">
              <Lock className="w-3 h-3" /> Waits while
            </div>
            <ul className="grid sm:grid-cols-2 gap-x-4 gap-y-0.5">
              {waits.map((r) => (
                <li key={r.id}>• {r.label}</li>
              ))}
            </ul>
          </>
        )}
      </div>
    </details>
  );
};
