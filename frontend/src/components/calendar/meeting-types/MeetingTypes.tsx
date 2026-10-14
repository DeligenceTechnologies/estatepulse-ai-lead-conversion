import React, { useEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, Check } from 'lucide-react';
import { getMeetingTypes, type CalendarEventType, type CalendarProviderId } from '../../../utils/calendarApi';
import { PanelCard, RowSkeleton, useProviderData } from '../shared/CalendarPanel';
import { Empty, Notice, POOLING_LABEL, PROVIDERS } from '../shared/ui';
import { CopyLink, OpenLink } from './links';
import { MeetingsPanel } from './MeetingsPanel';
import { durationLabel, typeColors, upcomingByType, type MeetingFilters } from './meetings';

/** Re-render often enough for "in 5 min" and "Live now" to stay true. */
const CLOCK_TICK_MS = 30_000;

const useNow = (): number => {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), CLOCK_TICK_MS);
    return () => window.clearInterval(timer);
  }, []);
  return now;
};

/** Each meeting type as a card; picking one shows only its meetings below. */
const EventTypeGrid: React.FC<{
  items: CalendarEventType[];
  colors: Map<string, string>;
  upcoming: Map<string, number> | null;
  selected: string[];
  onSelect: (id: string) => void;
}> = ({ items, colors, upcoming, selected, onSelect }) => (
  <ul className="grid gap-2 sm:grid-cols-2 xl:grid-cols-3 list-none">
    {items.map((type) => {
      const active = selected.includes(type.id);
      const booked = upcoming?.get(type.id) ?? 0;
      const color = colors.get(type.id);
      return (
        <li
          key={type.id}
          className={`relative rounded-xl border bg-slate-950/60 transition-colors ${
            active ? 'border-slate-500 bg-slate-800/40' : 'border-slate-800 hover:border-slate-700'
          }`}
        >
          <span aria-hidden className="absolute left-0 top-3 bottom-3 w-1 rounded-r-full" style={{ backgroundColor: color }} />
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
);

/** Meeting types with their booking links, and every meeting booked on them. */
export const MeetingTypes: React.FC<{ provider: CalendarProviderId }> = ({ provider }) => {
  const label = PROVIDERS[provider].label;
  const { data, error, loading, reload } = useProviderData(getMeetingTypes);
  const now = useNow();
  const [filters, setFilters] = useState<MeetingFilters>({ types: [], showCanceled: false });
  const meetingsRef = useRef<HTMLDivElement>(null);

  const eventTypes = useMemo(() => data?.eventTypes ?? [], [data]);
  const colors = useMemo(() => typeColors(eventTypes), [eventTypes]);
  const upcoming = useMemo(
    () => (data && !data.meetingsError ? upcomingByType(data.meetings, now) : null),
    [data, now],
  );

  // Clicking the one selected card again clears it; any other card shows only that type.
  const selectType = (id: string) => {
    const only = filters.types.length === 1 && filters.types[0] === id;
    setFilters({ ...filters, types: only ? [] : [id] });
    if (!only) meetingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
  };

  const refresh = () => void reload();

  if (error) {
    return (
      <PanelCard
        icon={CalendarDays}
        title="Meeting types"
        hint={`Live from ${label}.`}
        count={undefined}
        loading={loading}
        providerLabel={label}
        onRefresh={refresh}
      >
        <Notice tone="error">{error}</Notice>
      </PanelCard>
    );
  }

  return (
    <div className="space-y-4">
      <PanelCard
        icon={CalendarDays}
        title="Meeting types"
        hint={`Live from ${label}. Pick one to see its meetings, or share its link with a lead.`}
        count={data?.eventTypes.length}
        loading={loading}
        providerLabel={label}
        onRefresh={refresh}
      >
        {data === null ? (
          <RowSkeleton />
        ) : eventTypes.length === 0 ? (
          <Empty icon={CalendarDays} title="No meeting types yet">
            Create one in {label}, then refresh.
          </Empty>
        ) : (
          <EventTypeGrid
            items={eventTypes}
            colors={colors}
            upcoming={upcoming}
            selected={filters.types}
            onSelect={selectType}
          />
        )}
      </PanelCard>

      <div ref={meetingsRef} className="scroll-mt-4">
        <MeetingsPanel
          meetings={data?.meetings ?? null}
          window={data?.meetingsWindow ?? null}
          eventTypes={eventTypes}
          colors={colors}
          error={data?.meetingsError ?? null}
          now={now}
          filters={filters}
          onFiltersChange={setFilters}
          loading={loading}
          providerLabel={label}
          onRefresh={refresh}
        />
      </div>
    </div>
  );
};
