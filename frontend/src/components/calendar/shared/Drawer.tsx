import React, { useEffect, useId, useRef } from 'react';
import { X } from 'lucide-react';

const WIDTH = { md: 'sm:max-w-md', xl: 'sm:max-w-3xl' } as const;

/**
 * A panel sliding in from the right with a title row and a scrolling body.
 * Focus moves to Close on open and back to the opener on close; Escape or a
 * click outside closes it.
 */
export const Drawer: React.FC<{
  icon: React.ElementType;
  title: React.ReactNode;
  hint: React.ReactNode;
  /** Beside Close, e.g. a Sync button. */
  actions?: React.ReactNode;
  width?: keyof typeof WIDTH;
  onClose: () => void;
  children: React.ReactNode;
}> = ({ icon: Icon, title, hint, actions, width = 'md', onClose, children }) => {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    const opener = document.activeElement as HTMLElement | null;
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      opener?.focus?.();
    };
  }, [onClose]);

  return (
    <div className="fixed inset-0 z-50 flex justify-end" role="dialog" aria-modal="true" aria-labelledby={titleId}>
      <div className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm animate-fade-in" onClick={onClose} />

      <aside
        className={`relative w-full ${WIDTH[width]} h-full bg-slate-900 border-l border-slate-800 shadow-2xl flex flex-col animate-slide-in-right text-slate-100`}
      >
        <header className="flex items-start gap-3 px-5 py-4 border-b border-slate-800">
          <span className="w-9 h-9 rounded-xl bg-slate-950 border border-slate-800 text-emerald-400 flex items-center justify-center shrink-0">
            <Icon className="w-4 h-4" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 id={titleId} className="text-sm font-bold text-white flex items-center gap-2">
              {title}
            </h3>
            <p className="text-xs text-slate-400 mt-0.5">{hint}</p>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            {actions}
            <button
              ref={closeButton}
              type="button"
              onClick={onClose}
              aria-label="Close"
              className="w-8 h-8 rounded-lg text-slate-400 hover:text-slate-100 hover:bg-slate-800 flex items-center justify-center shrink-0 cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </header>

        <div className="flex-1 min-h-0 overflow-y-auto custom-scrollbar p-4 sm:p-5">{children}</div>
      </aside>
    </div>
  );
};
