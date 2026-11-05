import React from 'react';

/**
 * The shell every list-shaped card on the dashboards is built from.
 *
 * The card is a flex column and only its body scrolls, so a card whose list
 * keeps growing — lead sources, agents, call outcomes — stops stretching its
 * row once it reaches the height its grid gives it. Same object as
 * IntegrationCard's body; a new card gets the behaviour by using this shell
 * rather than by repeating the classes.
 *
 * The height itself is the caller's: a card only scrolls where it is given one
 * (the dashboard grids cap their children), and grows naturally everywhere else.
 */
export const Panel: React.FC<{
  title: string;
  icon?: React.ReactNode;
  /** A string renders as the muted note on the right; a node renders as given. */
  aside?: React.ReactNode;
  /** Grid placement and any height cap for this one card. */
  className?: string;
  children: React.ReactNode;
}> = ({ title, icon, aside, className = '', children }) => (
  <div
    className={`bg-slate-900/90 border border-slate-800 rounded-2xl p-5 shadow-xl flex flex-col gap-4 min-h-0 ${className}`}
  >
    <div className="flex flex-wrap items-center justify-between gap-2 shrink-0">
      <div className="flex items-center gap-2 min-w-0">
        {icon && <span className="text-slate-500 shrink-0">{icon}</span>}
        <h3 className="text-sm font-bold text-white truncate">{title}</h3>
      </div>
      {typeof aside === 'string' ? <span className="text-2xs text-slate-500 shrink-0">{aside}</span> : aside}
    </div>

    <div className="custom-scrollbar flex-1 min-h-0 overflow-y-auto overscroll-contain space-y-4 pr-1 -mr-1">
      {children}
    </div>
  </div>
);
