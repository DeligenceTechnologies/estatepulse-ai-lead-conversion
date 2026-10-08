import React, { useEffect, useId, useRef, useState } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';

export interface FilterOption {
  value: string;
  label: string;
  /** Optional leading marker, e.g. a status dot. */
  icon?: React.ReactNode;
}

interface FilterDropdownProps {
  /** Shown on the button, e.g. "Role". */
  label: string;
  icon?: React.ReactNode;
  options: FilterOption[];
  /** '' means "no filter". */
  value: string;
  onChange: (value: string) => void;
  /** The "no filter" entry at the top of the menu, e.g. "All roles". Omit for a required choice (sort). */
  allLabel?: string;
  /** Extra classes for the wrapper (e.g. responsive visibility). */
  className?: string;
  /** Open the menu above the button — for controls pinned to the bottom of the screen. */
  placement?: 'bottom' | 'top';
  /** Which edge of the button the menu lines up with. */
  align?: 'left' | 'right';
  /** 'compact' shows only the chosen value ("25 ▾"), for small inline pickers. */
  variant?: 'filter' | 'compact';
}

/**
 * A filter pill: "Role" when unset, "Role: Agent" when set (highlighted, with a
 * one-click clear). Opens a small menu instead of a native <select>, so it
 * looks the same in every browser and theme.
 *
 * Keyboard: Enter/Space/ArrowDown opens, arrows move, Enter picks, Escape closes.
 */
export const FilterDropdown: React.FC<FilterDropdownProps> = ({
  label,
  icon,
  options,
  value,
  onChange,
  allLabel,
  className = '',
  placement = 'bottom',
  align = 'left',
  variant = 'filter',
}) => {
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listId = useId();

  const entries: FilterOption[] = allLabel ? [{ value: '', label: allLabel }, ...options] : options;
  const selected = options.find((o) => o.value === value);
  const active = allLabel !== undefined && value !== '';

  // Close on a click anywhere else.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: MouseEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    return () => document.removeEventListener('mousedown', onPointer);
  }, [open]);

  const openMenu = (): void => {
    setHighlight(Math.max(0, entries.findIndex((e) => e.value === value)));
    setOpen(true);
  };

  const pick = (next: string): void => {
    onChange(next);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent): void => {
    if (!open) {
      if (['Enter', ' ', 'ArrowDown'].includes(e.key)) {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    if (e.key === 'Escape') {
      e.preventDefault();
      setOpen(false);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setHighlight((h) => (h + 1) % entries.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setHighlight((h) => (h - 1 + entries.length) % entries.length);
    } else if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      const entry = entries[highlight];
      if (entry) pick(entry.value);
    } else if (e.key === 'Tab') {
      setOpen(false);
    }
  };

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      {variant === 'compact' ? (
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          aria-label={`${label}: ${selected?.label ?? ''}`}
          className={`h-8 pl-2.5 pr-2 rounded-lg border text-xs font-semibold flex items-center gap-1.5 transition-colors cursor-pointer ${
            open
              ? 'bg-slate-800 border-slate-600 text-slate-100'
              : 'bg-slate-950 border-slate-800 text-slate-200 hover:border-slate-600'
          }`}
        >
          <span className="tabular-nums">{selected?.label}</span>
          <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />
        </button>
      ) : (
        <button
          type="button"
          onClick={() => (open ? setOpen(false) : openMenu())}
          onKeyDown={onKeyDown}
          aria-haspopup="listbox"
          aria-expanded={open}
          aria-controls={listId}
          className={`h-9 pl-3 ${active ? 'pr-8' : 'pr-2.5'} rounded-lg border text-xs font-medium flex items-center gap-1.5 whitespace-nowrap transition-colors cursor-pointer ${
            active
              ? 'bg-emerald-500/10 border-emerald-500/40 text-emerald-200'
              : open
                ? 'bg-slate-800 border-slate-600 text-slate-100'
                : 'bg-slate-900 border-slate-800 text-slate-300 hover:border-slate-700 hover:text-slate-100'
          }`}
        >
          {icon && <span className={active ? 'text-emerald-400' : 'text-slate-500'}>{icon}</span>}
          <span>{label}</span>
          {selected && (allLabel === undefined || active) && (
            <>
              <span className={active ? 'text-emerald-500/60' : 'text-slate-600'}>:</span>
              <span className="font-semibold max-w-32 truncate">{selected.label}</span>
            </>
          )}
          {!active && <ChevronDown className={`w-3.5 h-3.5 text-slate-500 transition-transform ${open ? 'rotate-180' : ''}`} />}
        </button>
      )}

      {active && (
        <button
          type="button"
          onClick={() => onChange('')}
          aria-label={`Clear ${label} filter`}
          className="absolute right-1.5 top-1/2 -translate-y-1/2 p-1 rounded text-emerald-300/70 hover:text-emerald-100 hover:bg-emerald-500/20 cursor-pointer"
        >
          <X className="w-3 h-3" />
        </button>
      )}

      {open && (
        <ul
          id={listId}
          role="listbox"
          aria-label={label}
          className={`absolute z-30 ${placement === 'top' ? 'bottom-full mb-1.5' : 'top-full mt-1.5'} ${
            align === 'right' ? 'right-0' : 'left-0'
          } ${variant === 'compact' ? 'min-w-24' : 'min-w-44'} max-h-72 overflow-y-auto custom-scrollbar py-1 bg-slate-900 border border-slate-700/80 rounded-xl shadow-2xl shadow-black/40 animate-in fade-in duration-100`}
        >
          {entries.map((entry, i) => {
            const isSelected = entry.value === value;
            return (
              <li
                key={entry.value || '__all'}
                role="option"
                aria-selected={isSelected}
                onMouseEnter={() => setHighlight(i)}
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => pick(entry.value)}
                className={`mx-1 px-2.5 py-2 rounded-lg text-xs flex items-center gap-2 cursor-pointer ${
                  i === highlight ? 'bg-slate-800 text-slate-100' : 'text-slate-300'
                } ${entry.value === '' && allLabel ? 'text-slate-400' : ''}`}
              >
                {entry.icon}
                <span className="flex-1 truncate">{entry.label}</span>
                {isSelected && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
};
