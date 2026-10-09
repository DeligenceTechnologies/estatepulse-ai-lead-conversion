import React, { useMemo } from 'react';
import { allTimeZones, utcOffset } from '../../utils/workingHours';

interface TimezoneSelectProps {
  id?: string;
  value: string;
  onChange: (zone: string) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * Every IANA zone the browser knows, labelled "Asia/Kolkata (GMT+5:30)". A
 * saved zone the browser does not list is still shown, so it is never lost.
 */
export const TimezoneSelect: React.FC<TimezoneSelectProps> = ({ id, value, onChange, disabled, className }) => {
  const zones = useMemo(() => {
    const now = new Date();
    return allTimeZones().map((zone) => ({ zone, label: `${zone.replace(/_/g, ' ')} (${utcOffset(zone, now)})` }));
  }, []);
  return (
    <select
      id={id}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      className={className}
    >
      {!zones.some((z) => z.zone === value) && <option value={value}>{value}</option>}
      {zones.map(({ zone, label }) => (
        <option key={zone} value={zone}>
          {label}
        </option>
      ))}
    </select>
  );
};
