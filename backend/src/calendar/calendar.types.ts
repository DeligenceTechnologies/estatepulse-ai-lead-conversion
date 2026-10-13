import type { CalendarProvider } from '@prisma/client';

export const PROVIDER_LABEL: Record<CalendarProvider, string> = {
  calendly: 'Calendly',
  cal: 'Cal.com',
};

export type WorkspaceRole = 'owner' | 'admin' | 'member';

export type PoolingType = 'round_robin' | 'collective' | 'managed' | 'multi_pool';

export interface ProviderAccount {
  id: string;
  email: string | null;
  name: string | null;
}

export interface SchedulingMember {
  externalId: string;
  name: string;
  email: string;
  role: WorkspaceRole;
  schedulingUrl: string | null;
  timezone: string | null;
}

export interface SchedulingEventType {
  id: string;
  name: string;
  durationMinutes: number;
  bookingUrl: string | null;
  poolingType: PoolingType | null;
  hostName: string | null;
}

export interface CalendlyCredentials {
  accessToken: string;
  refreshToken: string;
}

export interface CalCredentials {
  apiKey: string;
}

export interface CalendlyOAuthState {
  orgId: string;
  userId: string;
  expiresAt: number;
}
