import React from 'react';
import { useReducedMotion } from 'motion/react';
import { CalendarDays, FileSpreadsheet, FileText, Hexagon, Table2, Upload, Webhook } from 'lucide-react';
import { usePauseOffscreen } from './useLandingLook';

/** Only sources the product actually connects to today. */
const SOURCES: Array<{ name: string; Icon: React.FC }> = [
  { name: 'Google Forms', Icon: FileText },
  { name: 'Google Sheets', Icon: FileSpreadsheet },
  { name: 'HubSpot', Icon: Hexagon },
  { name: 'Airtable', Icon: Table2 },
  { name: 'Calendly', Icon: CalendarDays },
  { name: 'Custom webhook', Icon: Webhook },
  { name: 'CSV / Excel import', Icon: Upload },
];

const Row: React.FC<{ hidden?: boolean }> = ({ hidden }) => (
  <>
    {SOURCES.map(({ name, Icon }) => (
      <span key={name} className="lp-logo-chip" aria-hidden={hidden || undefined}>
        <Icon />
        {name}
      </span>
    ))}
  </>
);

/** An endless strip of lead sources; the copy exists only to make the loop seamless. */
export const SourcesMarquee: React.FC = () => {
  const reduce = useReducedMotion();
  const { ref, pausedClass } = usePauseOffscreen<HTMLElement>();
  return (
    <section ref={ref} className={`lp-marquee-band ${pausedClass}`} aria-label="Lead sources">
      <p className="lp-eyebrow">Connects to where your leads already come from</p>
      <div className="lp-marquee">
        <Row />
        {!reduce && <Row hidden />}
      </div>
    </section>
  );
};
