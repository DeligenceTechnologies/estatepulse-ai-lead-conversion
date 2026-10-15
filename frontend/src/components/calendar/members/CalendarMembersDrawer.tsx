import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { CalendarClock, Contact } from 'lucide-react';
import { useAuth } from '../../../context/AuthContext';
import { messageFor } from '../../../lib/api';
import { getOrganizationCalendar, type OrganizationCalendarStatus } from '../../../utils/calendarApi';
import { RowSkeleton } from '../shared/CalendarPanel';
import { Drawer } from '../shared/Drawer';
import { SyncButton } from '../shared/SyncButton';
import { Empty, Notice, PROVIDERS } from '../shared/ui';
import { CalendarMembers } from './CalendarMembers';

/**
 * The Team Members page's second view of people: everyone in the connected
 * Calendly or Cal.com workspace, with who is on the team already and a
 * one-click add for the rest. One Sync button, in the drawer's title row.
 */
export const CalendarMembersDrawer: React.FC<{ onAdded: () => void; onClose: () => void }> = ({ onAdded, onClose }) => {
  const navigate = useNavigate();
  const { can } = useAuth();
  const [status, setStatus] = useState<OrganizationCalendarStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncVersion, setSyncVersion] = useState(0);

  const load = useCallback(async () => {
    setError(null);
    try {
      setStatus(await getOrganizationCalendar());
    } catch (e) {
      setError(messageFor(e));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const provider = status?.provider ?? null;
  const connection = status?.connection ?? null;
  const connected = Boolean(provider && connection?.status === 'active');
  const label = provider ? PROVIDERS[provider].label : 'your calendar';

  const openCalendarSettings = () => {
    onClose();
    navigate('/settings?tab=calendar');
  };

  let body: React.ReactNode;
  if (error && !status) {
    body = <Notice tone="error">{error}</Notice>;
  } else if (!status) {
    body = <RowSkeleton />;
  } else if (!connected) {
    const broken = Boolean(connection);
    body = (
      <Empty icon={CalendarClock} title={broken ? 'Reconnect your calendar' : 'No calendar connected'}>
        {broken
          ? (connection?.lastError ?? 'The connection stopped working.')
          : 'Connect Calendly or Cal.com to see its members here and add them to your team.'}
        {can('organization.update') ? (
          <button
            type="button"
            onClick={openCalendarSettings}
            className="block mx-auto mt-4 h-9 px-4 rounded-lg bg-emerald-600 hover:bg-emerald-500 text-on-accent text-xs font-semibold cursor-pointer transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400"
          >
            {broken ? 'Reconnect calendar' : 'Connect calendar'}
          </button>
        ) : (
          ' Ask your owner to do it.'
        )}
      </Empty>
    );
  } else {
    // Keyed by connection so switching calendars never shows the old provider's rows.
    body = (
      <CalendarMembers key={connection!.connectedAt} provider={provider!} syncVersion={syncVersion} onAdded={onAdded} />
    );
  }

  return (
    <Drawer
      icon={Contact}
      title="Calendar members"
      hint={connected ? `Add people from ${label} to your team.` : 'People from your connected calendar.'}
      width="xl"
      actions={
        connected && (
          <SyncButton
            providerLabel={label}
            initialSyncedAt={connection?.syncedAt ?? null}
            onSynced={() => setSyncVersion((version) => version + 1)}
          />
        )
      }
      onClose={onClose}
    >
      {body}
    </Drawer>
  );
};
