/**
 * Typed client for the EstatePulse ingestion API.
 *
 * IMPORTANT: nothing under src/api/ may import from src/context/AppContext, and
 * nothing under src/context/ may import from here. AppContext is the in-browser
 * demo store (localStorage); this module talks to the real backend. Keeping the
 * dependency one-directional is what stops the two from being accidentally
 * merged — see the DEMO / LIVE badges in the UI.
 *
 * Requests go to a relative `/api` path, which the Vite dev server (and a
 * Netlify proxy in production) forwards to the backend while injecting the
 * API key server-side. The key is deliberately NOT a VITE_ variable: that
 * prefix would inline it into the public browser bundle, where anyone could
 * read it out of devtools.
 */

const BASE = '/api';

export class ApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the API. Is the server running on port 3001?');
  }

  if (res.status === 204) return undefined as T;

  const text = await res.text();
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // Non-JSON response (a proxy error page, typically).
  }

  if (!res.ok) {
    const err = (body as { error?: { code?: string; message?: string } } | null)?.error;
    throw new ApiError(
      res.status,
      err?.code ?? `HTTP_${res.status}`,
      err?.message ?? friendlyMessage(res.status),
    );
  }

  return body as T;
}

function friendlyMessage(status: number): string {
  switch (status) {
    case 401:
      return 'API key missing or invalid. Check API_KEY in your .env, then restart the dev server.';
    case 404:
      return 'Not found.';
    case 429:
      return 'Rate limited — try again shortly.';
    case 503:
      return 'The API is temporarily unavailable.';
    default:
      return `Request failed (${status}).`;
  }
}

// --- Types -----------------------------------------------------------------

export interface LeadSourceConfig {
  id: string;
  name: string;
  code: string;
  isActive: boolean;
  requireSignature: boolean;
  ingestStatus: string | null;
  mappingStatus: string | null;
  signingSecretPreview: string | null;
  signingSecretSetAt: string | null;
  externalFormName: string | null;
  lastEventAt: string | null;
  createdAt: string;
  /** Fully built URL, safe to display and copy. */
  webhookUrl: string | null;
  deliveryCount?: number;
}

/** Only ever returned by create/rotate — never by a GET. */
export interface LeadSourceWithSecret extends LeadSourceConfig {
  signingSecret: string;
}

export interface DeliveryAnswer {
  label: string;
  type: string;
  /** Option UUIDs already resolved to display text by the server. */
  value: string;
}

export interface WebhookDelivery {
  id: string;
  receivedAt: string;
  providerEventId: string | null;
  signatureState: string | null;
  usedPreviousSecret: boolean;
  queueState: string | null;
  outcome: string | null;
  outcomeReason: string | null;
  errorMessage: string | null;
  bodyBytes: number | null;
  formName: string | null;
  answers: DeliveryAnswer[];
  parseError: string | null;
}

// --- Endpoints -------------------------------------------------------------

export const api = {
  health: () => request<{ status: string; database: string; time: string }>('/v1/health'),

  listLeadSources: () => request<LeadSourceConfig[]>('/v1/lead-sources'),

  createLeadSource: (name: string, requireSignature = false) =>
    request<LeadSourceWithSecret>('/v1/lead-sources', {
      method: 'POST',
      body: JSON.stringify({ name, requireSignature }),
    }),

  deliveries: (id: string, limit = 25) =>
    request<WebhookDelivery[]>(`/v1/lead-sources/${id}/deliveries?limit=${limit}`),

  rotateSecret: (id: string, graceMinutes = 60) =>
    request<{ signingSecret: string; graceMinutes: number }>(
      `/v1/lead-sources/${id}/rotate-secret`,
      { method: 'POST', body: JSON.stringify({ graceMinutes }) },
    ),

  setPaused: (id: string, paused: boolean) =>
    request<{ paused: boolean }>(`/v1/lead-sources/${id}/pause`, {
      method: 'POST',
      body: JSON.stringify({ paused }),
    }),
};

// --- Leads -----------------------------------------------------------------

export interface LiveLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  phoneValid: boolean;
  status: string;
  temperature: string | null;
  score: number;
  location: string | null;
  timeline: string | null;
  buyingIntent: string | null;
  financingStatus: string | null;
  minBudget: number | null;
  maxBudget: number | null;
  bedrooms: number | null;
  motivation: string | null;
  consentStatus: string;
  dncStatus: boolean;
  customFields: Record<string, string>;
  submissionCount: number;
  /** `type` is the ingestion mechanism ('webhook'); `name` is the form's label. */
  source: { id: string; name: string; type: string } | null;
  createdAt: string;
  updatedAt: string;
}

export interface LeadStats {
  byStatus: Record<string, number>;
  total: number;
}

export const leadsApi = {
  list: (status?: string) =>
    request<LiveLead[]>(`/v1/leads${status ? `?status=${encodeURIComponent(status)}` : ''}`),
  stats: () => request<LeadStats>('/v1/leads/stats'),
};
