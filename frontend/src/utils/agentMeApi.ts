import { apiFetch } from '../lib/api';

/**
 * The signed-in agent's own view of their work.
 *
 * Every path below is `/agents/me/...` — there is no agent id in any of them.
 * The server resolves the agent from the session, so the browser has no way to
 * ask for somebody else's leads, and nothing here should ever grow a parameter
 * that would let it.
 */

export interface AgentDashboard {
  activeLeads: number;
  newLeads: number;
  upcomingAppointments: number;
  totalAssignedLeads: number;
}

export interface AgentLead {
  id: string;
  firstName: string | null;
  lastName: string | null;
  email: string | null;
  phone: string | null;
  /** new | contacted | qualified | nurture | booked | closed | lost */
  status: string;
  /** hot | warm | cold, or null when the AI call has not rated them. */
  temperature: string | null;
  source: { name: string; provider: string } | null;
  createdAt: string;
  /** When this agent was given the lead. */
  assignedAt: string | null;
}

/** The list row plus the qualification detail already stored on the lead. */
export interface AgentLeadDetail extends AgentLead {
  location: string | null;
  timeline: string | null;
  buyingIntent: string | null;
  minBudget: number | null;
  maxBudget: number | null;
  motivation: string | null;
  aiSummary: string | null;
  consentStatus: string;
  dncStatus: boolean;
}

export const getAgentDashboard = (): Promise<AgentDashboard> =>
  apiFetch<AgentDashboard>('/agents/me/dashboard', { auth: true });

export const getMyLeads = (): Promise<AgentLead[]> =>
  apiFetch<AgentLead[]>('/agents/me/leads', { auth: true });

export const getMyLead = (leadId: string): Promise<AgentLeadDetail> =>
  apiFetch<AgentLeadDetail>(`/agents/me/leads/${leadId}`, { auth: true });

/** "Ada Lovelace", or the email, or a dash — never a fabricated placeholder. */
export const leadName = (l: AgentLead): string => {
  const name = [l.firstName, l.lastName].filter(Boolean).join(' ').trim();
  return name.length > 0 ? name : (l.email ?? '—');
};
