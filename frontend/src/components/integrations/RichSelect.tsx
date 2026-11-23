import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Check, ChevronDown, Search } from 'lucide-react';

export interface RichOption {
  value: string;
  label: string;
  /** A second, quieter line: a model name, an id, a region. */
  sublabel?: string;
  /** A small pill on the right, e.g. "In use". */
  badge?: string;
}

/**
 * A themed dropdown for picking from what a Telnyx account already has (its
 * numbers, its assistants). A custom list rather than a native <select>: the OS
 * draws that popup in its own light colours, ignoring the dark theme. Long
 * lists get a filter box so a 40-number account is still one keystroke away.
 */
export const RichSelect: React.FC<{
  options: RichOption[];
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
  icon?: React.ReactNode;
  mono?: boolean;
  emptyText?: string;
  /** Show the filter box from this many options up. */
  searchFrom?: number;
}> = ({ options, value, onChange, placeholder, icon, mono, emptyText = 'Nothing here yet.', searchFrom = 6 }) => {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  // Fixed, measured from the trigger: the dialog body scrolls, and an absolute
  // list would be clipped by it or stretch it. Opens upward when there is no room below.
  const [pos, setPos] = useState<React.CSSProperties>({});
  const ref = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const place = () => {
    const r = ref.current?.getBoundingClientRect();
    if (!r) return;
    const below = window.innerHeight - r.bottom;
    const up = below < 300 && r.top > below;
    setPos(
      up
        ? { position: 'fixed', left: r.left, width: r.width, bottom: window.innerHeight - r.top + 6 }
        : { position: 'fixed', left: r.left, width: r.width, top: r.bottom + 6 },
    );
  };

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    // Captured and stopped, so Escape closes this list and not the dialog around it.
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        setOpen(false);
      }
    };
    // Scrolling the page under a fixed list would leave it floating; close it instead.
    const onScroll = (e: Event) => {
      if (!listRef.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey, true);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', place);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey, true);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', place);
    };
  }, [open]);

  useEffect(() => {
    if (!open) setQuery('');
  }, [open]);

  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => `${o.label} ${o.sublabel ?? ''} ${o.value}`.toLowerCase().includes(q));
  }, [options, query]);

  const selected = options.find((o) => o.value === value);

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        onClick={() => {
          if (!open) place();
          setOpen((o) => !o);
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full h-11 bg-slate-950 border rounded-xl px-3 flex items-center gap-2.5 text-left transition-colors focus:outline-none focus:border-emerald-500 cursor-pointer ${
          open ? 'border-emerald-500 ring-2 ring-emerald-500/15' : 'border-slate-800 hover:border-slate-600'
        }`}
      >
        {icon && <span className="text-emerald-400 shrink-0 [&>svg]:w-4 [&>svg]:h-4">{icon}</span>}
        <span className="min-w-0 flex-1">
          {selected ? (
            <span className="flex items-baseline gap-2 min-w-0">
              <span className={`text-sm text-white truncate ${mono ? 'font-mono' : 'font-medium'}`}>{selected.label}</span>
              {selected.sublabel && <span className="text-2xs text-slate-500 truncate">{selected.sublabel}</span>}
            </span>
          ) : (
            <span className="text-sm text-slate-500">{placeholder}</span>
          )}
        </span>
        <ChevronDown className={`w-4 h-4 text-slate-500 shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>

      {open && (
        <div
          ref={listRef}
          role="listbox"
          aria-label={placeholder}
          style={pos}
          className="z-[60] bg-slate-950 border border-slate-700 rounded-xl shadow-2xl overflow-hidden"
        >
          {options.length >= searchFrom && (
            <div className="p-2 border-b border-slate-800">
              <div className="flex items-center gap-2 bg-slate-900 border border-slate-800 rounded-lg px-2.5 h-8">
                <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search…"
                  className="flex-1 bg-transparent text-xs text-white placeholder:text-slate-500 focus:outline-none"
                />
              </div>
            </div>
          )}
          {shown.length === 0 ? (
            <div className="px-3 py-3 text-xs text-slate-400">{options.length ? 'No matches.' : emptyText}</div>
          ) : (
            <ul className="max-h-60 overflow-y-auto p-1">
              {shown.map((o) => {
                const active = o.value === value;
                return (
                  <li key={o.value}>
                    <button
                      type="button"
                      role="option"
                      aria-selected={active}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                      className={`w-full px-2.5 py-2 rounded-lg flex items-center gap-3 text-left cursor-pointer transition-colors ${
                        active ? 'bg-emerald-500/10' : 'hover:bg-slate-800/70'
                      }`}
                    >
                      <span className="min-w-0 flex-1">
                        <span className={`block text-xs truncate ${mono ? 'font-mono' : 'font-semibold'} ${active ? 'text-emerald-300' : 'text-slate-100'}`}>
                          {o.label}
                        </span>
                        {o.sublabel && <span className="block text-2xs text-slate-500 truncate mt-0.5">{o.sublabel}</span>}
                      </span>
                      {o.badge && (
                        <span className="text-2xs font-semibold px-1.5 py-0.5 rounded-full bg-slate-800 text-slate-300 border border-slate-700 shrink-0">
                          {o.badge}
                        </span>
                      )}
                      {active && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
};
