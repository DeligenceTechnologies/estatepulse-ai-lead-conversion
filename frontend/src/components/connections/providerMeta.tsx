import React from 'react';
import { CalendarDays, Database, PhoneCall, Users, Webhook } from 'lucide-react';
import type { ConnectionCategory, ProviderKey } from '../../utils/connectionsApi';
import { ConnectCalendar } from '../calendar/connect/ConnectCalendar';
import { AirtableCard } from '../integrations/AirtableCard';
import { ConnectionCards } from '../integrations/ConnectionCards';
import { GoogleFormsCard } from '../integrations/GoogleFormsCard';
import { GoogleSheetsCard } from '../integrations/GoogleSheetsCard';
import { HubSpotCard } from '../integrations/HubSpotCard';
import { TelnyxCard } from '../integrations/TelnyxCard';

/** A tile on the hub: a Nango provider, or the custom webhook (no account to connect). */
export type TileKey = ProviderKey | 'webhook';

export interface Brand {
  /** Two letters on the brand mark. Our own monogram, not the provider's logo. */
  mark: string;
  /** Gradient of the brand mark. */
  gradient: string;
  /** Soft glow behind a connected tile. */
  glow: string;
  /** Ring and accents once connected. */
  ring: string;
}

export const BRANDS: Record<TileKey, Brand> = {
  google: { mark: 'G', gradient: 'from-sky-500 to-blue-600', glow: 'shadow-sky-500/20', ring: 'ring-sky-500/40' },
  airtable: { mark: 'At', gradient: 'from-amber-400 to-orange-500', glow: 'shadow-amber-500/20', ring: 'ring-amber-500/40' },
  typeform: { mark: 'Tf', gradient: 'from-slate-500 to-slate-700', glow: 'shadow-slate-400/20', ring: 'ring-slate-400/40' },
  tally: { mark: 'Ta', gradient: 'from-pink-500 to-rose-600', glow: 'shadow-pink-500/20', ring: 'ring-pink-500/40' },
  hubspot: { mark: 'Hs', gradient: 'from-orange-500 to-red-500', glow: 'shadow-orange-500/20', ring: 'ring-orange-500/40' },
  calendly: { mark: 'Ca', gradient: 'from-blue-500 to-indigo-600', glow: 'shadow-blue-500/20', ring: 'ring-blue-500/40' },
  cal: { mark: 'Cc', gradient: 'from-zinc-600 to-zinc-800', glow: 'shadow-zinc-400/20', ring: 'ring-zinc-400/40' },
  telnyx: { mark: 'Tx', gradient: 'from-emerald-500 to-teal-600', glow: 'shadow-emerald-500/20', ring: 'ring-emerald-500/40' },
  webhook: { mark: '{}', gradient: 'from-violet-500 to-fuchsia-600', glow: 'shadow-violet-500/20', ring: 'ring-violet-500/40' },
};

export const CATEGORIES: { id: ConnectionCategory; label: string; hint: string; icon: React.ElementType }[] = [
  { id: 'leads', label: 'Lead sources', hint: 'Where your leads come from', icon: Database },
  { id: 'crm', label: 'CRM', hint: 'Keep contacts in sync', icon: Users },
  { id: 'calendar', label: 'Calendar', hint: 'Let leads book meetings', icon: CalendarDays },
  { id: 'calling', label: 'Calling & SMS', hint: 'AI calls and texts from your numbers', icon: PhoneCall },
];

/** The custom webhook tile: not an account, so not in the server's catalog. */
export const WEBHOOK_TILE = {
  key: 'webhook' as const,
  label: 'Webhook',
  description: 'One URL for your website, Zapier, Make or any app. Map the fields on screen.',
  category: 'leads' as ConnectionCategory,
  icon: Webhook,
};

/**
 * What a provider's drawer shows below its accounts: the setup that belongs
 * to the provider's own feature (pick sheets, tables, forms, a number, a team).
 * Each is the card the feature already has, rendered without its chrome.
 */
export function SetupPanel({ tile }: { tile: TileKey }): React.ReactElement | null {
  switch (tile) {
    case 'google':
      return (
        <div className="space-y-8">
          <GoogleSheetsCard />
          <GoogleFormsCard />
        </div>
      );
    case 'airtable':
      return <AirtableCard />;
    case 'hubspot':
      return <HubSpotCard />;
    case 'tally':
      return <ConnectionCards only="TALLY" />;
    case 'typeform':
      return <ConnectionCards only="TYPEFORM" />;
    case 'webhook':
      return <ConnectionCards only="WEBHOOK" />;
    case 'telnyx':
      return <TelnyxCard />;
    case 'calendly':
    case 'cal':
      return <ConnectCalendar />;
    default:
      return null;
  }
}
