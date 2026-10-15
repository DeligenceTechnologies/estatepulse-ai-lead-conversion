import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CalendarCheck2, CalendarRange } from 'lucide-react';
import { getMeetingTypes, type CalendarProviderId } from '../../../utils/calendarApi';
import { PanelCard, useProviderData, useReloadOnSync } from '../shared/CalendarPanel';
import { Notice, PROVIDERS } from '../shared/ui';
import { EventTypesDrawer } from './EventTypesDrawer';
import { MeetingsPanel } from './MeetingsPanel';
import { typeColors, upcomingByType, type MeetingFilters } from './meetings';

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

/** Every meeting booked in the connected calendar; the Events button lists what leads can book. */
export const Meetings: React.FC<{ provider: CalendarProviderId; syncVersion: number }> = ({ provider, syncVersion }) => {
  const label = PROVIDERS[provider].label;
  const { data, error, loading, reload } = useProviderData(getMeetingTypes);
  useReloadOnSync(syncVersion, reload);
  const now = useNow();
  const [filters, setFilters] = useState<MeetingFilters>({ types: [], showCanceled: false });
  const [eventsOpen, setEventsOpen] = useState(false);

  const eventTypes = useMemo(() => data?.eventTypes ?? [], [data]);
  const colors = useMemo(() => typeColors(eventTypes), [eventTypes]);
  const upcoming = useMemo(
    () => (data && !data.meetingsError ? upcomingByType(data.meetings, now) : null),
    [data, now],
  );

  // Picking the one selected event again clears it; any other shows only that event's meetings.
  const selectType = (id: string) => {
    const only = filters.types.length === 1 && filters.types[0] === id;
    setFilters({ ...filters, types: only ? [] : [id] });
    setEventsOpen(false);
  };
  const closeEvents = useCallback(() => setEventsOpen(false), []);

  if (error) {
    return (
      <PanelCard icon={CalendarCheck2} title="Meetings" hint={`Booked in ${label}.`} count={undefined} loading={loading}>
        <Notice tone="error">{error}</Notice>
      </PanelCard>
    );
  }

  const eventsButton = (
    <button
      type="button"
      onClick={() => setEventsOpen(true)}
      disabled={data === null}
      aria-haspopup="dialog"
      title="Event types and their booking links"
      className="h-9 px-3 rounded-lg border border-slate-700 text-xs font-semibold text-slate-300 hover:border-slate-600 hover:text-white inline-flex items-center gap-1.5 shrink-0 cursor-pointer transition-colors disabled:opacity-50 disabled:cursor-not-allowed focus:outline-none focus-visible:ring-2 focus-visible:ring-slate-500"
    >
      <CalendarRange className="w-3.5 h-3.5" />
      Events
      {data && <span className="text-2xs text-slate-500 tabular-nums">{eventTypes.length}</span>}
    </button>
  );

  return (
    <>
      <MeetingsPanel
        meetings={data?.meetings ?? null}
        window={data?.meetingsWindow ?? null}
        eventTypes={eventTypes}
        colors={colors}
        error={data?.meetingsError ?? null}
        now={now}
        filters={filters}
        onFiltersChange={setFilters}
        loading={loading && data !== null}
        actions={eventsButton}
      />
      {eventsOpen && (
        <EventTypesDrawer
          providerLabel={label}
          items={eventTypes}
          colors={colors}
          upcoming={upcoming}
          selected={filters.types}
          onSelect={selectType}
          onClose={closeEvents}
        />
      )}
    </>
  );
};
