/**
 * Core Data Models & Schema for EstatePulse AI
 * Matches Supabase PostgreSQL Schema & n8n workflow events (PRD Section 17 & 25)
 * 
 * BACKEND INTEGRATION HOOKS:
 * - Supabase tables: `leads`, `conversations`, `messages`, `calls`, `qualifications`, `lead_scores`, `appointments`, `followup_sequences`, `integrations`, `audit_logs`
 * - n8n Webhooks: `WF-01` to `WF-19`
 * - Voice Provider: Retell AI / Vapi
 * - SMS Provider: Twilio
 * - CRM: Follow Up Boss / GoHighLevel / Custom Webhooks
 */

export type LeadTemperature = 'hot' | 'warm' | 'cold';

export type LeadStatus = 
  | 'new'
  | 'contacted'
  | 'engaged'
  | 'qualified'
  | 'appointment_booked'
  | 'nurture'
  | 'human_handoff'
  | 'closed'
  | 'dnc'
  | 'lost';

export type LeadSource = 
  | 'website'
  | 'facebook'
  | 'google'
  | 'zillow'
  | 'manual'
  | 'webhook';

export type Channel = 'voice' | 'sms' | 'email' | 'web_chat';

export type CallOutcome = 
  | 'ANSWERED'
  | 'NO_ANSWER'
  | 'BUSY'
  | 'VOICEMAIL'
  | 'WRONG_NUMBER'
  | 'CALLBACK_REQUESTED'
  | 'QUALIFIED'
  | 'NOT_INTERESTED'
  | 'APPOINTMENT_BOOKED'
  | 'HUMAN_HANDOFF'
  | 'FAILED';

export interface LeadScoreRuleApplied {
  rule: string;
  points: number;
  description: string;
}

export interface LeadScoreBreakdown {
  score: number; // 0 - 100
  temperature: LeadTemperature;
  rulesApplied: LeadScoreRuleApplied[];
  reasoningSummary: string;
  calculatedAt: string;
}

export interface QualificationData {
  intent: 'buyer' | 'seller' | 'investor' | 'undecided';
  timeline: 'under_30_days' | '1_to_3_months' | '3_to_6_months' | 'over_6_months' | 'undecided';
  budgetMin: number;
  budgetMax: number;
  preferredLocations: string[];
  propertyType: 'single_family' | 'condo' | 'townhouse' | 'multi_family' | 'any';
  bedrooms?: number;
  financingStatus: 'pre_approved' | 'cash_buyer' | 'needs_lender' | 'not_preapproved' | 'unknown';
  preapprovalLender?: string;
  motivation?: string;
  appointmentRequested: boolean;
  handoffRequired: boolean;
  confidence: number; // 0 to 1
  qualificationStatus: 'complete' | 'partial' | 'in_progress' | 'unqualified';
}

export interface Lead {
  id: string;
  organizationId: string;
  assignedAgentId: string;
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  source: LeadSource;
  sourceId?: string;
  status: LeadStatus;
  leadType: 'buyer' | 'seller';
  preferredLocation: string;
  budgetMin: number;
  budgetMax: number;
  propertyType: string;
  bedrooms: number;
  timeline: string;
  financingStatus: string;
  preapprovalStatus: boolean;
  score: number;
  temperature: LeadTemperature;
  scoreBreakdown?: LeadScoreBreakdown;
  qualification?: QualificationData;
  lastContactedAt?: string;
  nextFollowupAt?: string;
  consentStatus: 'granted' | 'revoked' | 'pending';
  dncStatus: boolean;
  createdAt: string;
  updatedAt: string;
  notes?: string;
  automationPaused?: boolean;
}

export interface Message {
  id: string;
  conversationId: string;
  leadId: string;
  direction: 'inbound' | 'outbound';
  channel: Channel;
  sender: 'ai' | 'lead' | 'agent';
  senderName: string;
  recipient: string;
  content: string;
  status: 'sent' | 'delivered' | 'read' | 'failed';
  createdAt: string;
  metadata?: Record<string, any>;
}

export interface Conversation {
  id: string;
  organizationId: string;
  leadId: string;
  channel: Channel;
  status: 'active' | 'completed' | 'paused' | 'transferred_to_agent';
  startedAt: string;
  endedAt?: string;
  summary: string;
  intent: string;
  sentiment: 'positive' | 'neutral' | 'skeptical' | 'negative';
  messages: Message[];
  unreadCount?: number;
}

export interface TranscriptTurn {
  speaker: 'AI (Alex)' | 'Lead' | 'Agent';
  text: string;
  timestamp: string;
}

export interface CallRecord {
  id: string;
  organizationId: string;
  leadId: string;
  leadName: string;
  leadPhone: string;
  agentId: string;
  provider: 'retell' | 'vapi' | 'twilio';
  providerCallId: string;
  direction: 'inbound' | 'outbound';
  status: 'completed' | 'in_progress' | 'failed';
  outcome: CallOutcome;
  durationSeconds: number;
  recordingUrl?: string;
  transcript: TranscriptTurn[];
  summary: string;
  startedAt: string;
  endedAt: string;
  extractedData?: Partial<QualificationData>;
  scoreResult?: number;
}

export interface Agent {
  id: string;
  organizationId: string;
  name: string;
  email: string;
  phone: string;
  avatarUrl: string;
  calendarUrl: string;
  workingHours: string;
  timezone: string;
  status: 'available' | 'in_call' | 'busy' | 'offline';
  assignedLeadsCount: number;
  conversionRate: number;
  role: 'owner' | 'admin' | 'agent';
}

export interface Appointment {
  id: string;
  organizationId: string;
  leadId: string;
  leadName: string;
  agentId: string;
  agentName: string;
  provider: 'calendly' | 'google_calendar';
  externalEventId?: string;
  startTime: string;
  endTime: string;
  status: 'scheduled' | 'completed' | 'cancelled' | 'rescheduled';
  appointmentType: 'Discovery Call' | 'Property Consultation' | 'Showing' | 'Buyer Consultation';
  locationOrLink: string;
  notes?: string;
  createdAt: string;
}

export interface FollowupTask {
  id: string;
  sequenceId: string;
  step: number;
  channel: Channel;
  delayHours: number;
  scheduledAt: string;
  status: 'pending' | 'sent' | 'skipped' | 'stopped';
  messageTemplate: string;
}

export interface FollowupSequence {
  id: string;
  organizationId: string;
  name: string;
  status: 'active' | 'paused' | 'draft';
  trigger: 'NO_ANSWER' | 'WARM_NURTURE' | 'COLD_REACTIVATION' | 'POST_CONSULTATION';
  description: string;
  enrolledLeadsCount: number;
  steps: {
    step: number;
    delay: string;
    channel: Channel;
    actionDescription: string;
  }[];
  createdAt: string;
}

export interface IntegrationStatus {
  id: string;
  provider: 'follow_up_boss' | 'gohighlevel' | 'retell' | 'twilio' | 'calendly';
  name: string;
  category: 'CRM' | 'Voice AI' | 'Telephony' | 'Calendar';
  iconName: string;
  status: 'connected' | 'error' | 'disconnected';
  lastSyncAt: string;
  description: string;
  config: {
    apiKeySet: boolean;
    webhookUrl: string;
    accountReference?: string;
  };
}

export interface AuditLog {
  id: string;
  timestamp: string;
  action: string;
  entityType: 'lead' | 'call' | 'appointment' | 'crm' | 'followup' | 'system';
  entityId: string;
  description: string;
  actor: 'AI (Alex)' | 'System (n8n)' | 'Agent' | 'Webhook';
  metadata?: Record<string, any>;
}

export interface OrganizationSettings {
  id: string;
  name: string;
  slug: string;
  timezone: string;
  industry: string;
  businessHours: {
    days: string;
    start: string;
    end: string;
  };
  aiAgentName: string;
  aiTone: 'Conversational' | 'Professional' | 'Friendly' | 'Concise';
  serviceAreas: string[];
  autoCallOnLeadArrival: boolean;
  maxCallsPerDay: number;
  dncEnforcement: boolean;
  communicationStrategy: 'Strategy B (Voice -> SMS if unanswered)' | 'Strategy A (SMS -> Voice)' | 'Strategy C (SMS -> Voice -> Follow-up)';
  leadRoutingMethod: 'round_robin' | 'geographic' | 'availability' | 'source_based';
}
