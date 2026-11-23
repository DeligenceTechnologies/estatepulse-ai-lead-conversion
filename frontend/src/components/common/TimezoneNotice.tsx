import React from 'react';
import { AlertTriangle, Lightbulb } from 'lucide-react';

/** One-line version, for tooltips. */
export const NO_TIMEZONE_FIELD_NOTICE =
  'No “Time Zone” question or column is mapped. EstatePulse will estimate each lead’s timezone from their phone number when possible; leads with toll-free, ambiguous, or unsupported numbers wait until their timezone is manually confirmed. Map a Time Zone column for exact local calling hours.';

/**
 * Why a time zone field matters and what to do.
 * `hint` (before a source is added): a recommendation, sky-blue.
 * `warn` (on a mapping screen with nothing mapped to Time Zone): amber.
 * Neither blocks anything: without the field, the phone number decides.
 */
export const TimezoneNotice: React.FC<{ tone?: 'warn' | 'hint'; className?: string }> = ({ tone = 'warn', className = '' }) => {
  const hint = tone === 'hint';
  const box = hint ? 'bg-sky-500/10 border-sky-500/30 text-sky-100' : 'bg-amber-500/10 border-amber-500/30 text-amber-100';
  const Icon = hint ? Lightbulb : AlertTriangle;
  return (
    <div className={`border rounded-xl p-3 text-xs leading-relaxed flex gap-2.5 ${box} ${className}`}>
      <Icon className={`w-4 h-4 mt-0.5 shrink-0 ${hint ? 'text-sky-300' : 'text-amber-400'}`} />
      <div className="space-y-1.5 min-w-0">
        <div className="font-semibold text-white">
          {hint ? 'Recommended: Add a “Time Zone” question or column to your form, sheet, or file' : 'No “Time Zone” question or column is mapped'}
        </div>
        <p>
          EstatePulse schedules calls and texts based on each lead’s local time and applicable calling restrictions. Providing the lead’s
          timezone helps us determine their local calling hours more accurately.
        </p>
        <ol className="list-decimal pl-4 space-y-0.5">
          <li>Add a Time Zone question or column (e.g., Eastern, Pacific) to your source.</li>
          <li>
            When mapping fields, map that column to <span className="font-semibold">Time Zone</span>.
          </li>
        </ol>
        <p className="opacity-80">
          Optional. If you don’t provide a timezone, EstatePulse will estimate it using the lead’s phone number when possible. Phone-based
          estimates may not reflect the lead’s current location. Leads with toll-free, ambiguous, or unsupported numbers will wait until their
          timezone is manually confirmed.
        </p>
      </div>
    </div>
  );
};
