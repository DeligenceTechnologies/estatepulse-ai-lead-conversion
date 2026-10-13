import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { IntegrationEnv } from '@/common/utils/interface';
import type {
  PoolingType,
  ProviderAccount,
  SchedulingEventType,
  SchedulingMember,
  WorkspaceRole,
} from '../calendar.types';
import { requestJson } from './provider-http';

const AUTH_BASE = 'https://auth.calendly.com';
const API_BASE = 'https://api.calendly.com';
const PROVIDER = 'Calendly';
const PAGE_SIZE = 100;
const MAX_PAGES = 10;

interface TokenResponse {
  access_token: string;
  refresh_token: string;
  expires_in: number;
  owner: string;
  organization: string;
}

interface CalendlyUser {
  uri: string;
  name: string;
  email: string;
  scheduling_url: string | null;
  timezone: string | null;
}

interface CalendlyMembership {
  role: string;
  user: CalendlyUser;
}

interface CalendlyEventType {
  uri: string;
  name: string;
  duration: number;
  scheduling_url: string | null;
  pooling_type: string | null;
  profile: { name: string | null } | null;
}

interface Page<T> {
  collection: T[];
  pagination: { next_page: string | null };
}

export interface CalendlyGrant {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
  userUri: string;
  organizationUri: string;
}

@Injectable()
export class CalendlyClient {
  private readonly clientId?: string;
  private readonly clientSecret?: string;
  private readonly redirectUri?: string;
  readonly appUrl?: string;

  constructor(config: ConfigService<IntegrationEnv, true>) {
    this.clientId = config.get('CALENDLY_CLIENT_ID', { infer: true });
    this.clientSecret = config.get('CALENDLY_CLIENT_SECRET', { infer: true });
    this.redirectUri = config.get('CALENDLY_REDIRECT_URI', { infer: true });
    this.appUrl = config.get('APP_URL', { infer: true });
  }

  get missingConfig(): string[] {
    const required = {
      CALENDLY_CLIENT_ID: this.clientId,
      CALENDLY_CLIENT_SECRET: this.clientSecret,
      CALENDLY_REDIRECT_URI: this.redirectUri,
      APP_URL: this.appUrl,
    };
    return Object.entries(required)
      .filter(([, value]) => !value)
      .map(([name]) => name);
  }

  get configured(): boolean {
    return this.missingConfig.length === 0;
  }

  authorizeUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId ?? '',
      response_type: 'code',
      redirect_uri: this.redirectUri ?? '',
      state,
    });
    return `${AUTH_BASE}/oauth/authorize?${params}`;
  }

  exchangeCode(code: string): Promise<CalendlyGrant> {
    return this.token({ grant_type: 'authorization_code', code, redirect_uri: this.redirectUri ?? '' });
  }

  refresh(refreshToken: string): Promise<CalendlyGrant> {
    return this.token({ grant_type: 'refresh_token', refresh_token: refreshToken });
  }

  async revoke(token: string): Promise<void> {
    await requestJson(PROVIDER, `${AUTH_BASE}/oauth/revoke`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ token, client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '' }),
    });
  }

  async currentUser(accessToken: string): Promise<ProviderAccount> {
    const { resource } = await this.get<{ resource: CalendlyUser }>(accessToken, `${API_BASE}/users/me`);
    return { id: resource.uri, email: resource.email, name: resource.name };
  }

  async roleOf(accessToken: string, organizationUri: string, userUri: string): Promise<WorkspaceRole | null> {
    const url = `${API_BASE}/organization_memberships?${new URLSearchParams({ organization: organizationUri, user: userUri })}`;
    const page = await this.get<Page<CalendlyMembership>>(accessToken, url);
    const role = page.collection[0]?.role;
    return role ? toRole(role) : null;
  }

  async members(accessToken: string, organizationUri: string): Promise<SchedulingMember[]> {
    const memberships = await this.collect<CalendlyMembership>(
      accessToken,
      `${API_BASE}/organization_memberships?${new URLSearchParams({ organization: organizationUri, count: String(PAGE_SIZE) })}`,
    );
    return memberships.map(({ role, user }) => ({
      externalId: user.uri,
      name: user.name,
      email: user.email,
      role: toRole(role),
      schedulingUrl: user.scheduling_url,
      timezone: user.timezone,
    }));
  }

  async eventTypes(accessToken: string, organizationUri: string): Promise<SchedulingEventType[]> {
    const eventTypes = await this.collect<CalendlyEventType>(
      accessToken,
      `${API_BASE}/event_types?${new URLSearchParams({ organization: organizationUri, active: 'true', count: String(PAGE_SIZE) })}`,
    );
    return eventTypes.map((eventType) => ({
      id: eventType.uri,
      name: eventType.name,
      durationMinutes: eventType.duration,
      bookingUrl: eventType.scheduling_url,
      poolingType: toPooling(eventType.pooling_type),
      hostName: eventType.profile?.name ?? null,
    }));
  }

  private async token(grant: Record<string, string>): Promise<CalendlyGrant> {
    const body = await requestJson<TokenResponse>(PROVIDER, `${AUTH_BASE}/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ ...grant, client_id: this.clientId ?? '', client_secret: this.clientSecret ?? '' }),
    });
    return {
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: new Date(Date.now() + body.expires_in * 1000),
      userUri: body.owner,
      organizationUri: body.organization,
    };
  }

  private get<T>(accessToken: string, url: string): Promise<T> {
    return requestJson<T>(PROVIDER, url, { headers: { Authorization: `Bearer ${accessToken}` } });
  }

  private async collect<T>(accessToken: string, firstPage: string): Promise<T[]> {
    const items: T[] = [];
    let next: string | null = firstPage;
    for (let page = 0; next && page < MAX_PAGES; page++) {
      const result: Page<T> = await this.get<Page<T>>(accessToken, next);
      items.push(...result.collection);
      next = result.pagination.next_page;
    }
    return items;
  }
}

function toRole(role: string): WorkspaceRole {
  return role === 'owner' || role === 'admin' ? role : 'member';
}

function toPooling(type: string | null): PoolingType | null {
  return type === 'round_robin' || type === 'collective' || type === 'multi_pool' ? type : null;
}
