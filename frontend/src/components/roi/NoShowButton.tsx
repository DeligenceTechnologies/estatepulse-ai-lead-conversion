import React, { useEffect, useState } from 'react';
import { UserX } from 'lucide-react';
import { toast } from 'react-toastify';
import { messageFor } from '../../lib/api';
import { putNoShow, sourceRoiEnabled } from '../../utils/sourceRoiApi';
import { Button } from '../common/Button';

interface Props {
  appointment: { id: string; status: string; endTime: string; noShowAt?: string | null };
  /** Called once the server has recorded the change, with the new mark. */
  onChanged: (noShowAt: string | null) => void;
}

/** A meeting counts as held once its time has passed, unless someone says the lead did not show up. */
export const wasDue = (appointment: { status: string; endTime: string }, now = Date.now()): boolean =>
  appointment.status === 'scheduled' && new Date(appointment.endTime).getTime() < now;

/**
 * Whether the appointment counts as a no-show: it is marked and still scheduled. A mark on a
 * meeting that was cancelled afterwards counts for nothing, and the report does not count it.
 */
export const isNoShow = (appointment: { status: string; noShowAt?: string | null }): boolean =>
  Boolean(appointment.noShowAt) && appointment.status === 'scheduled';

/** The button shows for an appointment that can be marked, and for one already marked (so the mark can always be taken back). */
export const canToggleNoShow = (
  appointment: { status: string; endTime: string; noShowAt?: string | null },
  now = Date.now(),
): boolean => Boolean(appointment.noShowAt) || wasDue(appointment, now);

/**
 * "No-show" on an appointment that was due to happen, and "Undo" once marked.
 *
 * Renders nothing for an appointment that is cancelled, rescheduled or not
 * over yet, and nothing at all where Source ROI is switched off. Anyone who
 * can see the lead may use it: the agent who sat waiting is the one who knows.
 */
export const NoShowButton: React.FC<Props> = ({ appointment, onChanged }) => {
  const [enabled, setEnabled] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void sourceRoiEnabled().then((on) => alive && setEnabled(on));
    return () => {
      alive = false;
    };
  }, []);

  if (!enabled || !canToggleNoShow(appointment)) return null;
  const marked = Boolean(appointment.noShowAt);

  const toggle = async (): Promise<void> => {
    setSaving(true);
    try {
      const result = await putNoShow(appointment.id, !marked);
      onChanged(result.noShowAt);
      toast.success(marked ? 'No-show removed.' : 'Marked as a no-show.');
    } catch (e) {
      toast.error(messageFor(e));
    } finally {
      setSaving(false);
    }
  };

  return (
    <Button
      variant={marked ? 'ghost' : 'outline'}
      size="sm"
      onClick={() => void toggle()}
      loading={saving}
      title={marked ? 'The lead did show up after all' : 'The lead did not show up for this appointment'}
      icon={marked ? undefined : <UserX />}
    >
      {marked ? 'Undo no-show' : 'No-show'}
    </Button>
  );
};
