import React from 'react';
import { CalendarRange, Check } from 'lucide-react';
import type { CalendarEventType } from '../../../utils/calendarApi';
import { Drawer } from '../shared/Drawer';
import { Empty, POOLING_LABEL } from '../shared/ui';
import { CopyLink, OpenLink } from './links';
import { durationLabel } from './meetings';

/**
 * The workspace's event types (what leads can book), each with its booking
 * link and upcoming count. Picking one shows only its meetings on the page.
 */
export const EventTypesDrawer: React.FC<{
  providerLabel: string;
  items: CalendarEventType[];
  colors: Map<string, string>;
  upcoming: Map<string, number> | null;
  selected: string[];
  onSelect: (id: string) => void;
  onClose: () => void;
}> = ({ providerLabel, items, colors, upcoming, selected, onSelect, onClose }) => (
  <Drawer
    icon={CalendarRange}
    title={
      <>
        Events
        <span className="text-2xs font-semibold text-slate-300 bg-slate-800 rounded-md px-1.5 py-0.5 tabular-nums">
          {items.length}
        </span>
      </>
    }
    hint={`What leads can book in ${providerLabel}. Pick one to see only its meetings.`}
    onClose={onClose}
  >
    {items.length === 0 ? (
      <Empty icon={CalendarRange} title="No events yet">
        Create an event type in {providerLabel}, then press Sync.
      </Empty>
    ) : (
      <ul className="space-y-2 list-none">
        {items.map((type) => {
          const active = selected.includes(type.id);
          const booked = upcoming?.get(type.id) ?? 0;
          return (
            <li
              key={type.id}
              className={`relative rounded-xl border bg-slate-950/60 transition-colors ${
                active ? 'border-emerald-600/60 bg-emerald-500/5' : 'border-slate-800 hover:border-slate-700'
              }`}
            >
              <span
                aria-hidden
                className="absolute left-0 top-3 bottom-3 w-1 rounded-r-full"
                style={{ backgroundColor: colors.get(type.id) }}
              />
              <div className="flex items-start gap-2 pl-4 pr-2 py-3">
                <button
                  type="button"
                  onClick={() => onSelect(type.id)}
                  aria-pressed={active}
                  title={active ? 'Show all meetings' : 'Show only these meetings'}
                  className="min-w-0 flex-1 text-left cursor-pointer rounded-md focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
                >
                  <span className="flex items-center gap-1.5">
                    <span className="text-sm font-semibold text-white truncate">{type.name}</span>
                    {active && <Check className="w-3.5 h-3.5 text-emerald-400 shrink-0" />}
                  </span>
                  <span className="block text-2xs text-slate-400 mt-0.5 truncate">
                    {durationLabel(type.durationMinutes)}
                    {type.poolingType && ` · ${POOLING_LABEL[type.poolingType]}`}
                    {type.hostName && ` · ${type.hostName}`}
                  </span>
                  {upcoming && (
                    <span
                      className={`inline-flex mt-2 text-2xs font-semibold px-2 py-0.5 rounded-full tabular-nums ${
                        booked ? 'bg-emerald-500/10 text-emerald-300' : 'bg-slate-800 text-slate-500'
                      }`}
                    >
                      {booked ? `${booked} upcoming` : 'No upcoming'}
                    </span>
                  )}
                </button>
                {type.bookingUrl && (
                  <span className="flex items-center shrink-0">
                    <CopyLink url={type.bookingUrl} title={`Copy ${type.name} booking link`} />
                    <OpenLink url={type.bookingUrl} title={`Open ${type.name} booking page`} />
                  </span>
                )}
              </div>
            </li>
          );
        })}
      </ul>
    )}
  </Drawer>
);
