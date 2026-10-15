import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown, SlidersHorizontal } from 'lucide-react';
import type { CalendarEventType } from '../../../utils/calendarApi';
import type { MeetingFilters } from './meetings';

const Checkbox: React.FC<{ checked: boolean }> = ({ checked }) => (
  <span
    className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
      checked ? 'bg-emerald-600 border-emerald-500 text-on-accent' : 'border-slate-600'
    }`}
  >
    {checked && <Check className="w-3 h-3" />}
  </span>
);

/** Meeting types and "show canceled", in a small dropdown. */
export const FilterMenu: React.FC<{
  eventTypes: CalendarEventType[];
  colors: Map<string, string>;
  value: MeetingFilters;
  onChange: (value: MeetingFilters) => void;
}> = ({ eventTypes, colors, value, onChange }) => {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const active = value.types.length + (value.showCanceled ? 1 : 0);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  const toggleType = (id: string) =>
    onChange({
      ...value,
      types: value.types.includes(id) ? value.types.filter((t) => t !== id) : [...value.types, id],
    });

  return (
    <div ref={root} className="relative">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="true"
        aria-expanded={open}
        className={`h-9 px-3 rounded-lg border text-xs font-semibold inline-flex items-center gap-1.5 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500 ${
          active ? 'border-emerald-600/60 text-emerald-200 bg-emerald-500/10' : 'border-slate-700 text-slate-300 hover:border-slate-600 hover:text-white'
        }`}
      >
        <SlidersHorizontal className="w-3.5 h-3.5" />
        Filter
        {active > 0 && (
          <span className="min-w-[1rem] h-4 px-1 rounded-full bg-emerald-600 text-on-accent text-[10px] leading-4 tabular-nums">{active}</span>
        )}
        <ChevronDown className={`w-3.5 h-3.5 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div className="absolute z-30 mt-1.5 left-0 sm:left-auto sm:right-0 w-72 max-w-[calc(100vw-2rem)] rounded-xl border border-slate-700 bg-slate-900 shadow-2xl shadow-black/40 p-1.5">
          <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
            <span className="text-2xs font-bold uppercase tracking-wide text-slate-500">Meeting types</span>
            {active > 0 && (
              <button
                type="button"
                onClick={() => onChange({ types: [], showCanceled: false })}
                className="text-2xs font-semibold text-slate-400 hover:text-white cursor-pointer"
              >
                Clear all
              </button>
            )}
          </div>
          <div className="max-h-64 overflow-y-auto">
            {eventTypes.length === 0 ? (
              <p className="px-2 py-2 text-2xs text-slate-500">No meeting types.</p>
            ) : (
              eventTypes.map((type) => (
                <button
                  key={type.id}
                  type="button"
                  role="menuitemcheckbox"
                  aria-checked={value.types.includes(type.id)}
                  onClick={() => toggleType(type.id)}
                  className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-slate-800 cursor-pointer"
                >
                  <Checkbox checked={value.types.includes(type.id)} />
                  <span className="w-2 h-2 rounded-full shrink-0" style={{ backgroundColor: colors.get(type.id) }} />
                  <span className="min-w-0 flex-1 text-xs text-slate-200 truncate">{type.name}</span>
                  <span className="text-2xs text-slate-500 tabular-nums shrink-0">{type.durationMinutes}m</span>
                </button>
              ))
            )}
          </div>
          <div className="border-t border-slate-800 mt-1.5 pt-1.5">
            <button
              type="button"
              role="menuitemcheckbox"
              aria-checked={value.showCanceled}
              onClick={() => onChange({ ...value, showCanceled: !value.showCanceled })}
              className="w-full flex items-center gap-2.5 px-2 py-2 rounded-lg text-left hover:bg-slate-800 cursor-pointer"
            >
              <Checkbox checked={value.showCanceled} />
              <span className="text-xs text-slate-200">Show canceled meetings</span>
            </button>
          </div>
        </div>
      )}
    </div>
  );
};
