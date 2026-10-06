import { endSessionIfUnauthenticated, getToken } from '../lib/api';

/**
 * Typed client for the EstatePulse ingestion API.
 *
 * IMPORTANT: nothing under src/api/ may import from src/context/AppContext, and
 * nothing under src/context/ may import from here. AppContext is the in-browser
 * demo store (localStorage); this module talks to the real backend. Keeping the
 * dependency one-directional is what stops the two from being accidentally
 * merged — see the DEMO / LIVE badges in the UI.
 *
 * Requests go to a relative `/api` path, which the Vite dev server forwards to
 * the backend (and `VITE_API_URL` points at in production), carrying the same
 * session token the rest of the app uses. The backend's guard reads the
 * organization off that token.
 *
 * No API key is involved. An ingestion key can read a whole tenant, so it must
 * never reach the browser; and because the org comes from the session rather
 * than from a key baked into the build, two logged-in organizations can never
 * share one credential.
 */

// Same rule as src/lib/api.ts: relative in development, where the Vite proxy
// makes the API same-origin, and an absolute origin in production, where the
// SPA is served from a CDN that has no /api of its own.
const BASE = `${import.meta.env.VITE_API_URL ?? ''}/api`;

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
    const token = getToken();
    res = await fetch(`${BASE}${path}`, {
      ...init,
      headers: {
        'Content-Type': 'application/json',
        // Same session token the rest of the app uses. The bridge rejects the
        // request without it, so an expired session fails here rather than
        // silently reading another org's data.
        ...(token ? { Authorization: `Bearer ${token}` } : {}),
        ...(init?.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError(0, 'NETWORK', 'Cannot reach the API. Is the backend running on port 4000?');
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

    // A rejected session ends here exactly as it does in lib/api's apiFetch.
    // Without this the view showed "your session has expired" inside a shell
    // that still believed it was signed in, until the user reloaded by hand.
    endSessionIfUnauthenticated(res.status, err?.code);

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
      return 'Your session has expired. Sign in again.';
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
  /**
   * Leads this source produced. Not the same as `deliveryCount`: a delivery
   * carrying neither a usable phone nor email is stored and replayable but
   * never becomes a lead, so the two numbers disagreeing is information.
   */
  leadCount?: number;

  // --- set only on API-connected sources ---
  /** 'TALLY'. Absent on sources created before providers existed. */
  provider?: string | null;
  /** 'MANUAL' (customer pasted our URL) | 'API' (we installed the webhook). */
  connectionMethod?: string | null;
  externalFormId?: string | null;
  /** PENDING | INSTALLED | DRIFTED | UNINSTALLED | ORPHANED | ERROR */
  remoteState?: string | null;
  remoteSyncedAt?: string | null;
  remoteErrorMessage?: string | null;
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
  /**
   * Canonical lead fields this answer became; empty if it stayed an extra.
   * Usually one, but a single "Your name" or budget-range question feeds two.
   */
  targetFields: string[];
  /** 'mapped' | 'unmapped' | 'transform_error'; null if not yet processed. */
  mappingOutcome: string | null;
  /** e.g. an unrecognised dropdown option, or an unparseable phone. */
  warnings: string[];
}

/** Per-delivery normalization summary — null until the delivery is processed. */
export interface DeliveryMappingSummary {
  mapped: number;
  unmapped: number;
  errored: number;
  warnings: number;
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
  mapping: DeliveryMappingSummary | null;
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
  /** False => the address is stored but is never used to match this lead to another. */
  emailValid: boolean;
  status: string;
  /** Why the lead is in this status (e.g. "Call failed: …", "No answer …"); shown on hover. */
  statusReason: string | null;
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
  /** An answer we could not store, or a contact detail we could not use. */
  needsReview: boolean;
  reviewReasons: string[];
  submissionCount: number;
  /**
   * Leads in this organization sharing this one's phone (or email, when there is
   * no phone), itself included. >1 means the same contact details reached the
   * pipeline more than once — kept as separate leads on purpose, flagged so
   * nobody calls the same number twice without knowing.
   */
  contactLeadCount: number;
  /**
   * `name` is the form's label ('Buyer Inquiry'). `type` is the transport and is
   * always 'webhook'; the badge reads `provider`/`connectionMethod` instead, so
   * a form connected through Tally's API says so.
   */
  source: {
    id: string;
    name: string;
    type: string;
    provider: string | null;
    connectionMethod: string | null;
  } | null;
  /** The one current assignment; null means unassigned. */
  assignedAgent: {
    /** agent_profiles.id */
    id: string;
    name: string;
    /** 'manual' today; routing will add 'geographic' and 'round_robin'. */
    assignmentType: string;
    assignedAt: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

/** What PUT /v1/leads/:id/assignment answers. */
export interface LeadAssignment {
  leadId: string;
  agent: { id: string; name: string };
  assignmentType: string;
  assignedAt: string;
  /** False when the lead was already with that agent and nothing changed. */
  changed: boolean;
}

/**
 * Fired on window after this tab changes a lead, so the pipeline refetches at
 * once. The server's live `lead.assigned` event does the same for other tabs;
 * this one does not depend on the stream being connected.
 */
export const LEADS_CHANGED_EVENT = 'estatepulse:leads-changed';

export interface LeadStats {
  byStatus: Record<string, number>;
  total: number;
}

// --- Providers & connections ----------------------------------------------

/**
 * Capabilities are served by the backend rather than hardcoded here, so a
 * provider that cannot sign its webhooks (Jotform) or cannot list them changes
 * what the UI says without a frontend deploy.
 */
export interface ProviderInfo {
  code: string;
  displayName: string;
  capabilities: {
    supportsSigningSecret: boolean;
    supportsWebhookList: boolean;
    supportsWebhookUpdate: boolean;
    supportsExternalRef: boolean;
    installIsIdempotent: boolean;
    signatureHeader: string | null;
    credentialLabel: string;
    credentialHint: string;
  };
}

/** A stored credential. Never carries the key itself. */
export interface ProviderConnection {
  id: string;
  provider: string;
  label: string | null;
  /** Non-secret fragment, e.g. "tly-a1b2…7f3d". */
  credentialPreview: string;
  accountEmail: string | null;
  accountName: string | null;
  /** ACTIVE | INVALID | REVOKED */
  status: string;
  lastVerifiedAt: string | null;
  lastErrorCode: string | null;
  createdAt: string;
  /** How many lead sources depend on this credential. */
  leadSourceCount: number;
}

export interface ProviderForm {
  externalFormId: string;
  name: string;
  status: string | null;
  submissionCount: number | null;
  isClosed: boolean;
  updatedAt: string | null;
  /** Non-null when one of our lead sources already feeds from this form. */
  connectedLeadSourceId: string | null;
}

export interface ConnectFormResult extends LeadSourceConfig {
  connection: {
    method: string;
    provider: string;
    remoteState: string;
    externalFormId: string;
    externalWebhookId: string;
    credentialId: string;
  };
  /** Null when the form's schema could not be read; the first delivery maps it instead. */
  prebuild: {
    fields: number;
    mapped: number;
    unmapped: number;
    /** Targets deliberately left for a human — consent, in practice. */
    needsReview: string[];
    mappingStatus: string;
  } | null;
}

export const providersApi = {
  list: () => request<ProviderInfo[]>('/v1/integrations/providers'),

  connections: () => request<ProviderConnection[]>('/v1/integrations'),

  /** The only call that carries a raw provider key, and only in a POST body. */
  connect: (provider: string, apiKey: string, label?: string) =>
    request<ProviderConnection>('/v1/integrations', {
      method: 'POST',
      body: JSON.stringify({ provider, apiKey, label }),
    }),

  verify: (id: string) => request<ProviderConnection>(`/v1/integrations/${id}/verify`, { method: 'POST' }),

  disconnectAccount: (id: string, force = false) =>
    request<{ revoked: boolean; orphanedLeadSources: number }>(
      `/v1/integrations/${id}?force=${force}`,
      { method: 'DELETE' },
    ),

  forms: (id: string, cursor?: string | null) =>
    request<{ items: ProviderForm[]; nextCursor: string | null }>(
      `/v1/integrations/${id}/forms${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`,
    ),

  /** Creates the source, installs the webhook, and pre-maps the form. */
  connectForm: (credentialId: string, externalFormId: string, name?: string) =>
    request<ConnectFormResult>('/v1/lead-sources/connect', {
      method: 'POST',
      body: JSON.stringify({ credentialId, externalFormId, name }),
    }),

  resync: (leadSourceId: string) =>
    request<{ remoteState: string; repaired: boolean; removedDuplicates: number }>(
      `/v1/lead-sources/${leadSourceId}/resync`,
      { method: 'POST' },
    ),

  reinstall: (leadSourceId: string) =>
    request<{ remoteState: string; externalWebhookId: string }>(
      `/v1/lead-sources/${leadSourceId}/reinstall`,
      { method: 'POST' },
    ),

  disconnectForm: (leadSourceId: string, force = false) =>
    request<{ disconnected: boolean; remoteState: string; warning: string | null }>(
      `/v1/lead-sources/${leadSourceId}?force=${force}`,
      { method: 'DELETE' },
    ),
};

export const leadsApi = {
  list: (filter: { status?: string; sourceId?: string } = {}) => {
    const q = new URLSearchParams();
    if (filter.status) q.set('status', filter.status);
    if (filter.sourceId) q.set('sourceId', filter.sourceId);
    const qs = q.toString();
    return request<LiveLead[]>(`/v1/leads${qs ? `?${qs}` : ''}`);
  },
  stats: () => request<LeadStats>('/v1/leads/stats'),
  /** Owner-only. Assigning to someone else is a reassignment; the same agent is a no-op. */
  assign: (leadId: string, agentId: string) =>
    request<LeadAssignment>(`/v1/leads/${leadId}/assignment`, {
      method: 'PUT',
      body: JSON.stringify({ agentId }),
    }),
};
