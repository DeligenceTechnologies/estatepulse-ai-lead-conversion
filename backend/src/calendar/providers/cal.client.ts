import { Injectable } from '@nestjs/common';
import type {
  PoolingType,
  ProviderAccount,
  SchedulingEventType,
  SchedulingMember,
  WorkspaceRole,
} from '../calendar.types';
import { requestJson } from './provider-http';

const API_BASE = 'https://api.cal.com/v2';
const BOOKING_BASE = 'https://cal.com';
const PROVIDER = 'Cal.com';
const EVENT_TYPES_API_VERSION = '2024-06-14';
const PAGE_SIZE = 250;
const MAX_PAGES = 10;

interface Envelope<T> {
  status: string;
  data: T;
}

interface CalMe {
  id: number;
  email: string;
  name: string | null;
  username: string | null;
  timeZone: string | null;
}

export interface CalAccount extends ProviderAccount {
  username: string | null;
  timezone: string | null;
}

export interface CalTeam {
  id: number;
  name: string;
  slug: string | null;
  isOrganization: boolean;
}

interface CalMembership {
  userId: number;
  accepted: boolean;
  role: string;
  user: { email: string; name: string | null; username: string | null };
}

interface CalEventType {
  id: number;
  slug: string;
  title: string;
  lengthInMinutes: number;
  hidden: boolean;
  schedulingType?: string | null;
  hosts?: { name?: string | null }[];
}

@Injectable()
export class CalClient {
  async me(apiKey: string): Promise<CalAccount> {
    const me = await this.get<CalMe>(apiKey, '/me');
    return {
      id: String(me.id),
      email: me.email,
      name: me.name ?? me.username,
      username: me.username,
      timezone: me.timeZone,
    };
  }

  async personalMember(apiKey: string): Promise<SchedulingMember> {
    const account = await this.me(apiKey);
    return {
      externalId: account.id,
      name: account.name ?? account.email ?? account.id,
      email: account.email ?? '',
      role: 'owner',
      schedulingUrl: account.username ? `${BOOKING_BASE}/${account.username}` : null,
      timezone: account.timezone,
    };
  }

  async teams(apiKey: string): Promise<CalTeam[]> {
    const teams = await this.get<CalTeam[]>(apiKey, '/teams');
    return teams.map(({ id, name, slug, isOrganization }) => ({ id, name, slug, isOrganization: Boolean(isOrganization) }));
  }

  async members(apiKey: string, teamId: string): Promise<SchedulingMember[]> {
    const memberships: CalMembership[] = [];
    for (let page = 0; page < MAX_PAGES; page++) {
      const query = new URLSearchParams({ take: String(PAGE_SIZE), skip: String(page * PAGE_SIZE) });
      const batch = await this.get<CalMembership[]>(apiKey, `/teams/${teamId}/memberships?${query}`);
      memberships.push(...batch);
      if (batch.length < PAGE_SIZE) break;
    }
    return memberships
      .filter((membership) => membership.accepted)
      .map((membership) => ({
        externalId: String(membership.userId),
        name: membership.user.name ?? membership.user.username ?? membership.user.email,
        email: membership.user.email,
        role: toRole(membership.role),
        schedulingUrl: membership.user.username ? `${BOOKING_BASE}/${membership.user.username}` : null,
        timezone: null,
      }));
  }

  async teamEventTypes(apiKey: string, teamId: string, teamSlug: string | null): Promise<SchedulingEventType[]> {
    const eventTypes = await this.get<CalEventType[]>(apiKey, `/teams/${teamId}/event-types`);
    return toEventTypes(eventTypes, teamSlug ? `${BOOKING_BASE}/team/${teamSlug}` : null);
  }

  async personalEventTypes(apiKey: string, username: string | null): Promise<SchedulingEventType[]> {
    const query = username ? `?${new URLSearchParams({ username })}` : '';
    const eventTypes = await this.get<CalEventType[]>(apiKey, `/event-types${query}`, {
      'cal-api-version': EVENT_TYPES_API_VERSION,
    });
    return toEventTypes(eventTypes, username ? `${BOOKING_BASE}/${username}` : null);
  }

  private async get<T>(apiKey: string, path: string, headers: Record<string, string> = {}): Promise<T> {
    const body = await requestJson<Envelope<T>>(PROVIDER, `${API_BASE}${path}`, {
      headers: { ...headers, Authorization: `Bearer ${apiKey}` },
    });
    return body.data;
  }
}

function toEventTypes(eventTypes: CalEventType[], bookingBase: string | null): SchedulingEventType[] {
  return eventTypes
    .filter((eventType) => !eventType.hidden)
    .map((eventType) => ({
      id: String(eventType.id),
      name: eventType.title,
      durationMinutes: eventType.lengthInMinutes,
      bookingUrl: bookingBase ? `${bookingBase}/${eventType.slug}` : null,
      poolingType: toPooling(eventType.schedulingType ?? null),
      hostName: eventType.hosts?.length === 1 ? (eventType.hosts[0].name ?? null) : null,
    }));
}

function toRole(role: string): WorkspaceRole {
  const normalized = role.toLowerCase();
  return normalized === 'owner' || normalized === 'admin' ? normalized : 'member';
}

function toPooling(type: string | null): PoolingType | null {
  switch (type?.toUpperCase()) {
    case 'ROUND_ROBIN':
      return 'round_robin';
    case 'COLLECTIVE':
      return 'collective';
    case 'MANAGED':
      return 'managed';
    default:
      return null;
  }
}
