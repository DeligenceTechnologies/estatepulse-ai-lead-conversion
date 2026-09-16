import React, { createContext, useContext, useState, useEffect } from 'react';
import {
  Lead,
  Agent,
  Conversation,
  CallRecord,
  Appointment,
  FollowupSequence,
  IntegrationStatus,
  AuditLog,
  OrganizationSettings,
  LeadStatus,
  Message,
} from '../types';
import {
  INITIAL_ORG_SETTINGS,
  INITIAL_AGENTS,
  INITIAL_LEADS,
  INITIAL_CONVERSATIONS,
  INITIAL_CALLS,
  INITIAL_APPOINTMENTS,
  INITIAL_FOLLOWUP_SEQUENCES,
  INITIAL_INTEGRATIONS,
  INITIAL_AUDIT_LOGS,
} from '../data/mockData';

export type AppView = 
  | 'dashboard'
  | 'leads'
  | 'conversations'
  | 'calls'
  | 'appointments'
  | 'followups'
  | 'agents'
  | 'integrations'
  | 'ai_settings'
  | 'analytics'
  | 'landing_page'
  // Live-backend screen. Its data comes from the real API, NOT from this
  // context — see src/api/client.ts. Only the view id lives here.
  | 'lead_sources';

interface AppContextType {
  orgSettings: OrganizationSettings;
  updateOrgSettings: (settings: Partial<OrganizationSettings>) => void;
  agents: Agent[];
  leads: Lead[];
  conversations: Record<string, Conversation>;
  calls: CallRecord[];
  appointments: Appointment[];
  followupSequences: FollowupSequence[];
  integrations: IntegrationStatus[];
  auditLogs: AuditLog[];
  
  // Navigation & modals
  activeView: AppView;
  setActiveView: (view: AppView) => void;
  selectedLeadId: string | null;
  setSelectedLeadId: (id: string | null) => void;
  preCallLeadId: string | null;
  setPreCallLeadId: (id: string | null) => void;
  isSimulatingCall: boolean;
  activeSimulatedLead: Lead | null;
  startLiveCallSimulation: (lead: Lead) => void;
  closeLiveCallSimulation: () => void;

  /**
   * Leads that live in Postgres rather than in this demo store. The Leads view
   * registers the live rows it is rendering so the shared detail and pre-call
   * modals can resolve them by id. They arrive already shaped as `Lead` because
   * nothing under src/context/ may import the api client — see src/api/client.ts.
   *
   * Deliberately NOT persisted to localStorage: the backend owns these records,
   * so a stale copy must never outlive the fetch that produced it.
   */
  registerExternalLeads: (leads: Lead[]) => void;
  /** Demo store first, then the live registry. Use instead of leads.find(). */
  findLead: (id: string | null) => Lead | undefined;
  
  // Actions
  createLead: (leadInput: Partial<Lead>, triggerAutoWorkflow?: boolean) => Lead;
  updateLead: (id: string, updates: Partial<Lead>) => void;
  updateLeadStatus: (id: string, status: LeadStatus) => void;
  sendSmsMessage: (leadId: string, content: string, sender?: 'agent' | 'lead' | 'ai') => void;
  bookAppointment: (apptData: Omit<Appointment, 'id' | 'createdAt'>) => Appointment;
  toggleAutomation: (leadId: string) => void;
  takeOverConversation: (leadId: string) => void;
  triggerWebhookTest: (payload: any) => Lead;
  resetDemoData: () => void;
  simulateHotQualification: (leadId: string) => void;
  addAuditLog: (action: string, entityType: AuditLog['entityType'], entityId: string, description: string, actor?: AuditLog['actor']) => void;
}

const AppContext = createContext<AppContextType | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [orgSettings, setOrgSettings] = useState<OrganizationSettings>(() => {
    const saved = localStorage.getItem('ep_org_settings');
    return saved ? JSON.parse(saved) : INITIAL_ORG_SETTINGS;
  });

  const [agents, setAgents] = useState<Agent[]>(() => {
    const saved = localStorage.getItem('ep_agents');
    return saved ? JSON.parse(saved) : INITIAL_AGENTS;
  });

  const [leads, setLeads] = useState<Lead[]>(() => {
    const saved = localStorage.getItem('ep_leads');
    return saved ? JSON.parse(saved) : INITIAL_LEADS;
  });

  const [conversations, setConversations] = useState<Record<string, Conversation>>(() => {
    const saved = localStorage.getItem('ep_conversations');
    return saved ? JSON.parse(saved) : INITIAL_CONVERSATIONS;
  });

  const [calls, setCalls] = useState<CallRecord[]>(() => {
    const saved = localStorage.getItem('ep_calls');
    return saved ? JSON.parse(saved) : INITIAL_CALLS;
  });

  const [appointments, setAppointments] = useState<Appointment[]>(() => {
    const saved = localStorage.getItem('ep_appointments');
    return saved ? JSON.parse(saved) : INITIAL_APPOINTMENTS;
  });

  const [followupSequences, setFollowupSequences] = useState<FollowupSequence[]>(() => {
    const saved = localStorage.getItem('ep_sequences');
    return saved ? JSON.parse(saved) : INITIAL_FOLLOWUP_SEQUENCES;
  });

  const [integrations, setIntegrations] = useState<IntegrationStatus[]>(() => {
    const saved = localStorage.getItem('ep_integrations');
    return saved ? JSON.parse(saved) : INITIAL_INTEGRATIONS;
  });

  const [auditLogs, setAuditLogs] = useState<AuditLog[]>(() => {
    const saved = localStorage.getItem('ep_audit_logs');
    return saved ? JSON.parse(saved) : INITIAL_AUDIT_LOGS;
  });

  const [activeView, setActiveView] = useState<AppView>('dashboard');
  const [selectedLeadId, setSelectedLeadId] = useState<string | null>(null);
  const [preCallLeadId, setPreCallLeadId] = useState<string | null>(null);
  const [isSimulatingCall, setIsSimulatingCall] = useState(false);
  const [activeSimulatedLead, setActiveSimulatedLead] = useState<Lead | null>(null);
  const [externalLeads, setExternalLeads] = useState<Record<string, Lead>>({});

  // Persistence to local storage
  useEffect(() => {
    localStorage.setItem('ep_leads', JSON.stringify(leads));
  }, [leads]);

  useEffect(() => {
    localStorage.setItem('ep_conversations', JSON.stringify(conversations));
  }, [conversations]);

  useEffect(() => {
    localStorage.setItem('ep_calls', JSON.stringify(calls));
  }, [calls]);

  useEffect(() => {
    localStorage.setItem('ep_appointments', JSON.stringify(appointments));
  }, [appointments]);

  useEffect(() => {
    localStorage.setItem('ep_audit_logs', JSON.stringify(auditLogs));
  }, [auditLogs]);

  useEffect(() => {
    localStorage.setItem('ep_org_settings', JSON.stringify(orgSettings));
  }, [orgSettings]);

  const addAuditLog = (action: string, entityType: AuditLog['entityType'], entityId: string, description: string, actor: AuditLog['actor'] = 'System (n8n)') => {
    const newLog: AuditLog = {
      id: `log_${Date.now()}_${Math.random().toString(36).substring(2, 5)}`,
      timestamp: new Date().toISOString(),
      action,
      entityType,
      entityId,
      description,
      actor,
    };
    setAuditLogs(prev => [newLog, ...prev]);
  };

  const updateOrgSettings = (updates: Partial<OrganizationSettings>) => {
    setOrgSettings(prev => ({ ...prev, ...updates }));
    addAuditLog('Organization Settings Updated', 'system', orgSettings.id, 'Updated AI name, business hours, or communication rules', 'Agent');
  };

  /**
   * BACKEND INTEGRATION HOOK:
   * When deploying to production:
   * 1. Call Supabase: `await supabase.from('leads').insert(...)`
   * 2. Trigger n8n Workflow WF-01 (Lead Intake): `await fetch(N8N_WEBHOOK_URL_LEAD_INTAKE, { method: 'POST', body: JSON.stringify(lead) })`
   * 3. Workflow WF-05 will dispatch the Retell AI call or Twilio SMS according to communication strategy.
   */
  const createLead = (leadInput: Partial<Lead>, triggerAutoWorkflow: boolean = true): Lead => {
    // Round-robin assign agent
    const availableAgents = agents.filter(a => a.status === 'available');
    const assignedAgent = availableAgents.length > 0 
      ? availableAgents[Math.floor(Math.random() * availableAgents.length)]
      : agents[0];

    const leadId = `lead_${Date.now()}`;
    const newLead: Lead = {
      id: leadId,
      organizationId: orgSettings.id,
      assignedAgentId: assignedAgent.id,
      firstName: leadInput.firstName || 'Anonymous',
      lastName: leadInput.lastName || 'Lead',
      email: leadInput.email || 'lead@example.com',
      phone: leadInput.phone || '+1 (512) 555-0100',
      source: leadInput.source || 'website',
      sourceId: leadInput.sourceId || `src_${Date.now()}`,
      status: 'new',
      leadType: leadInput.leadType || 'buyer',
      preferredLocation: leadInput.preferredLocation || 'Austin, TX',
      budgetMin: leadInput.budgetMin || 450000,
      budgetMax: leadInput.budgetMax || 650000,
      propertyType: leadInput.propertyType || 'Single Family Home',
      bedrooms: leadInput.bedrooms || 3,
      timeline: leadInput.timeline || '1-3 months',
      financingStatus: leadInput.financingStatus || 'Exploring pre-approval',
      preapprovalStatus: leadInput.preapprovalStatus || false,
      score: 45,
      temperature: 'warm',
      scoreBreakdown: {
        score: 45,
        temperature: 'warm',
        rulesApplied: [
          { rule: 'Inbound Lead Ingested', points: 15, description: 'Direct interest submission' },
          { rule: 'Budget Declared ($450k-$650k)', points: 15, description: 'Budget matches active inventory' },
          { rule: 'Location Stated', points: 15, description: 'Target market within service area' },
        ],
        reasoningSummary: 'Inbound lead captured. Strategy B auto-call queued with 30s SLA.',
        calculatedAt: new Date().toISOString(),
      },
      consentStatus: 'granted',
      dncStatus: false,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      notes: leadInput.notes || 'Inbound prospect captured via lead form.',
    };

    setLeads(prev => [newLead, ...prev]);

    addAuditLog(
      'New Lead Ingested & Assigned',
      'lead',
      newLead.id,
      `Lead ${newLead.firstName} ${newLead.lastName} assigned to ${assignedAgent.name} via round-robin.`,
      'Webhook'
    );

    // Create initial conversation record
    const convId = `conv_${newLead.id}`;
    const initialConv: Conversation = {
      id: convId,
      organizationId: orgSettings.id,
      leadId: newLead.id,
      channel: 'sms',
      status: 'active',
      startedAt: new Date().toISOString(),
      summary: 'New conversation initiated upon lead capture.',
      intent: 'Buyer Inbound Inquiry',
      sentiment: 'neutral',
      messages: [
        {
          id: `msg_${Date.now()}`,
          conversationId: convId,
          leadId: newLead.id,
          direction: 'outbound',
          channel: 'sms',
          sender: 'ai',
          senderName: `${orgSettings.aiAgentName} (AI Assistant)`,
          recipient: newLead.phone,
          content: `Hi ${newLead.firstName}! This is ${orgSettings.aiAgentName} with ${orgSettings.name}. Thank you for reaching out about homes in ${newLead.preferredLocation}. Are you hoping to move in the next 30-90 days, or just starting to browse?`,
          status: 'delivered',
          createdAt: new Date().toISOString(),
        }
      ],
    };

    setConversations(prev => ({
      ...prev,
      [newLead.id]: initialConv,
    }));

    // If triggerAutoWorkflow is enabled, simulate instant AI reaction
    if (triggerAutoWorkflow) {
      setTimeout(() => {
        addAuditLog(
          'Automated Instant Response Dispatched',
          'call',
          newLead.id,
          `WF-04: Sent introductory SMS & queued outbound voice call (Response time: 14s).`,
          'AI (Alex)'
        );
        setLeads(current => current.map(l => l.id === newLead.id ? { ...l, status: 'contacted', lastContactedAt: 'Just now' } : l));
      }, 1200);
    }

    return newLead;
  };

  const updateLead = (id: string, updates: Partial<Lead>) => {
    setLeads(prev => prev.map(l => l.id === id ? { ...l, ...updates, updatedAt: new Date().toISOString() } : l));
  };

  const updateLeadStatus = (id: string, status: LeadStatus) => {
    setLeads(prev => prev.map(l => {
      if (l.id === id) {
        addAuditLog('Lead Status Updated', 'lead', id, `Status changed from ${l.status.toUpperCase()} to ${status.toUpperCase()}`, 'Agent');
        return { ...l, status, updatedAt: new Date().toISOString() };
      }
      return l;
    }));
  };

  /**
   * BACKEND INTEGRATION HOOK:
   * When sending an SMS in production:
   * `await twilioClient.messages.create({ from: TWILIO_PHONE, to: lead.phone, body: content })`
   * Listen to status callbacks via `POST /api/webhooks/twilio`
   */
  const sendSmsMessage = (leadId: string, content: string, sender: 'agent' | 'lead' | 'ai' = 'agent') => {
    const lead = leads.find(l => l.id === leadId);
    if (!lead) return;

    const conv = conversations[leadId] || {
      id: `conv_${leadId}`,
      organizationId: orgSettings.id,
      leadId,
      channel: 'sms',
      status: 'active',
      startedAt: new Date().toISOString(),
      summary: 'Direct SMS channel.',
      intent: 'Buyer Dialogue',
      sentiment: 'positive',
      messages: [],
    };

    const senderName = sender === 'ai' ? `${orgSettings.aiAgentName} (AI)` : sender === 'lead' ? `${lead.firstName} ${lead.lastName}` : 'Agent (You)';
    const newMessage: Message = {
      id: `msg_${Date.now()}`,
      conversationId: conv.id,
      leadId,
      direction: sender === 'lead' ? 'inbound' : 'outbound',
      channel: 'sms',
      sender,
      senderName,
      recipient: sender === 'lead' ? orgSettings.name : lead.phone,
      content,
      status: 'delivered',
      createdAt: new Date().toISOString(),
    };

    setConversations(prev => ({
      ...prev,
      [leadId]: {
        ...conv,
        messages: [...conv.messages, newMessage],
      }
    }));

    addAuditLog(`SMS ${sender === 'lead' ? 'Received' : 'Sent'}`, 'lead', leadId, `Message: "${content.substring(0, 50)}..."`, sender === 'ai' ? 'AI (Alex)' : 'Agent');

    // If sent by the lead, trigger intelligent AI reply after 1.8 seconds unless paused
    if (sender === 'lead' && !lead.automationPaused) {
      setTimeout(() => {
        let aiReply = "Thank you for the update! Let me check matching off-market properties and get back to you shortly.";
        const lower = content.toLowerCase();
        if (lower.includes('price') || lower.includes('budget') || lower.includes('cost')) {
          aiReply = `Understood! With homes in ${lead.preferredLocation} currently averaging $280-$340/sqft, keeping the budget around $${lead.budgetMin.toLocaleString()} to $${lead.budgetMax.toLocaleString()} puts you in a very competitive sweet spot.`;
        } else if (lower.includes('tomorrow') || lower.includes('meet') || lower.includes('call') || lower.includes('time') || lower.includes('yes')) {
          aiReply = "Fantastic! Would 10:00 AM or 2:30 PM tomorrow work best for a 15-minute introductory consult with our team lead?";
        } else if (lower.includes('stop') || lower.includes('unsubscribe') || lower.includes('dnc')) {
          aiReply = "You have been unsubscribed and added to our Do-Not-Contact list. No further automated messages will be sent.";
          updateLead(leadId, { dncStatus: true, automationPaused: true, status: 'dnc' });
          addAuditLog('DNC / STOP Request Processed', 'system', leadId, 'Lead requested STOP. Automated messaging permanently disabled.', 'System (n8n)');
        }

        const autoAiMsg: Message = {
          id: `msg_ai_${Date.now()}`,
          conversationId: conv.id,
          leadId,
          direction: 'outbound',
          channel: 'sms',
          sender: 'ai',
          senderName: `${orgSettings.aiAgentName} (AI)`,
          recipient: lead.phone,
          content: aiReply,
          status: 'delivered',
          createdAt: new Date().toISOString(),
        };

        setConversations(prev => {
          const c = prev[leadId];
          return {
            ...prev,
            [leadId]: {
              ...c,
              messages: [...c.messages, autoAiMsg],
            }
          };
        });
      }, 1500);
    }
  };

  /**
   * BACKEND INTEGRATION HOOK:
   * When booking an appointment:
   * 1. Call Calendly/Google Calendar API: create event with meeting link
   * 2. Update Follow Up Boss / GoHighLevel CRM task: `await fubClient.post('/appointments', ...)`
   * 3. Send email confirmation to agent and lead
   * 4. Pause automated cold/no-answer followups
   */
  const bookAppointment = (apptData: Omit<Appointment, 'id' | 'createdAt'>): Appointment => {
    const newAppt: Appointment = {
      ...apptData,
      id: `appt_${Date.now()}`,
      createdAt: new Date().toISOString(),
    };

    setAppointments(prev => [newAppt, ...prev]);

    // Update lead status to appointment_booked
    setLeads(prev => prev.map(l => {
      if (l.id === apptData.leadId) {
        return {
          ...l,
          status: 'appointment_booked',
          automationPaused: true, // Stop cold/no-answer sequences
          nextFollowupAt: `${new Date(newAppt.startTime).toLocaleDateString()} (${newAppt.appointmentType})`,
          updatedAt: new Date().toISOString(),
        };
      }
      return l;
    }));

    addAuditLog(
      'Appointment Booked & Follow-up Stopped',
      'appointment',
      newAppt.id,
      `${newAppt.appointmentType} booked with ${newAppt.agentName} for ${newAppt.leadName}. Automated follow-up halted.`,
      'AI (Alex)'
    );

    addAuditLog(
      'Follow Up Boss CRM Synchronized',
      'crm',
      newAppt.leadId,
      `Appointment and calendar invite pushed to Follow Up Boss contact profile.`,
      'System (n8n)'
    );

    return newAppt;
  };

  const toggleAutomation = (leadId: string) => {
    setLeads(prev => prev.map(l => {
      if (l.id === leadId) {
        const nextState = !l.automationPaused;
        addAuditLog(
          nextState ? 'Automation Paused' : 'Automation Resumed',
          'lead',
          leadId,
          nextState ? 'Agent paused automated voice & SMS outreach.' : 'Automated follow-up sequence re-enabled.',
          'Agent'
        );
        return { ...l, automationPaused: nextState };
      }
      return l;
    }));
  };

  const takeOverConversation = (leadId: string) => {
    toggleAutomation(leadId);
    setLeads(prev => prev.map(l => l.id === leadId ? { ...l, status: 'human_handoff' } : l));
    addAuditLog(
      'Human Agent Takeover',
      'lead',
      leadId,
      'Agent took over live messaging. AI responses suspended.',
      'Agent'
    );
  };

  /**
   * Simulates immediate conversion into a HOT lead with 87+ score,
   * extracted qualification data, and pre-call readiness (PRD Section 26 & 41)
   */
  const simulateHotQualification = (leadId: string) => {
    setLeads(prev => prev.map(l => {
      if (l.id === leadId) {
        const updated: Lead = {
          ...l,
          status: 'qualified',
          score: 89,
          temperature: 'hot',
          timeline: '1-3 months',
          bedrooms: 4,
          financingStatus: 'Pre-approval in progress',
          preapprovalStatus: true,
          scoreBreakdown: {
            score: 89,
            temperature: 'hot',
            rulesApplied: [
              { rule: 'Active Timeline (<60 days)', points: 20, description: 'Confirmed relocation date' },
              { rule: 'Budget Identified ($500k-$650k)', points: 10, description: 'Fits target submarket inventory' },
              { rule: 'Specific Location (North Austin)', points: 10, description: 'Verified top tier school district preference' },
              { rule: 'Pre-Approval Active', points: 15, description: 'In-progress with partner lender' },
              { rule: 'Appointment Request Accepted', points: 20, description: 'Ready for buyer consultation' },
              { rule: 'High Engagement Dialogue', points: 14, description: 'Completed multi-turn AI qualification' },
            ],
            reasoningSummary: 'Highly motivated family buyer. Relocating within 60 days. Budget $500k-$650k. Pre-call briefing prepared for immediate agent connection.',
            calculatedAt: new Date().toISOString(),
          },
          qualification: {
            intent: 'buyer',
            timeline: '1_to_3_months',
            budgetMin: l.budgetMin || 500000,
            budgetMax: l.budgetMax || 650000,
            preferredLocations: [l.preferredLocation || 'North Austin', 'Round Rock'],
            propertyType: 'single_family',
            bedrooms: 4,
            financingStatus: 'pre_approved',
            motivation: 'School district zoning and expanding family space.',
            appointmentRequested: true,
            handoffRequired: true,
            confidence: 0.96,
            qualificationStatus: 'complete',
          },
          updatedAt: new Date().toISOString(),
        };
        return updated;
      }
      return l;
    }));

    addAuditLog('Lead Scored: 89 (HOT 🔥)', 'lead', leadId, 'AI extracted complete buyer profile. Transferred to Hot Leads queue.', 'AI (Alex)');
  };

  /**
   * BACKEND INTEGRATION HOOK:
   * Used to test generic POST /api/webhooks/leads (PRD Section 66)
   */
  const triggerWebhookTest = (payload: any): Lead => {
    const lead = createLead({
      firstName: payload.first_name || 'Webhook',
      lastName: payload.last_name || 'Prospect',
      phone: payload.phone || '+1 (512) 555-0999',
      email: payload.email || 'webhook.lead@example.com',
      preferredLocation: payload.location || 'Austin, TX',
      budgetMin: Number(payload.budget_min) || 500000,
      budgetMax: Number(payload.budget_max) || 650000,
      source: 'webhook',
      sourceId: payload.source_id || `webhook_${Date.now()}`,
    }, true);

    addAuditLog(
      'Generic Webhook Payload Processed',
      'system',
      lead.id,
      `POST /api/webhooks/leads executed successfully with source: "${payload.source || 'webhook'}".`,
      'Webhook'
    );

    return lead;
  };

  const registerExternalLeads = (incoming: Lead[]) => {
    setExternalLeads(prev => {
      const next: Record<string, Lead> = {};
      for (const l of incoming) next[l.id] = l;
      // The Leads view re-registers on every poll; bail out when nothing moved so
      // a 5-second refresh does not re-render the whole app.
      const sameSize = Object.keys(prev).length === incoming.length;
      if (sameSize && incoming.every(l => prev[l.id] && prev[l.id].updatedAt === l.updatedAt)) return prev;
      return next;
    });
  };

  const findLead = (id: string | null) =>
    id ? leads.find(l => l.id === id) ?? externalLeads[id] : undefined;

  const startLiveCallSimulation = (lead: Lead) => {
    setActiveSimulatedLead(lead);
    setIsSimulatingCall(true);
  };

  const closeLiveCallSimulation = () => {
    setIsSimulatingCall(false);
    setActiveSimulatedLead(null);
  };

  const resetDemoData = () => {
    setOrgSettings(INITIAL_ORG_SETTINGS);
    setAgents(INITIAL_AGENTS);
    setLeads(INITIAL_LEADS);
    setConversations(INITIAL_CONVERSATIONS);
    setCalls(INITIAL_CALLS);
    setAppointments(INITIAL_APPOINTMENTS);
    setFollowupSequences(INITIAL_FOLLOWUP_SEQUENCES);
    setIntegrations(INITIAL_INTEGRATIONS);
    setAuditLogs(INITIAL_AUDIT_LOGS);
    localStorage.clear();
    addAuditLog('System Reset', 'system', 'demo_org', 'Reset application state to initial Austin Home Advisors demo scenario.', 'System (n8n)');
  };

  return (
    <AppContext.Provider
      value={{
        orgSettings,
        updateOrgSettings,
        agents,
        leads,
        conversations,
        calls,
        appointments,
        followupSequences,
        integrations,
        auditLogs,
        activeView,
        setActiveView,
        selectedLeadId,
        setSelectedLeadId,
        preCallLeadId,
        setPreCallLeadId,
        isSimulatingCall,
        activeSimulatedLead,
        registerExternalLeads,
        findLead,
        startLiveCallSimulation,
        closeLiveCallSimulation,
        createLead,
        updateLead,
        updateLeadStatus,
        sendSmsMessage,
        bookAppointment,
        toggleAutomation,
        takeOverConversation,
        triggerWebhookTest,
        resetDemoData,
        simulateHotQualification,
        addAuditLog,
      }}
    >
      {children}
    </AppContext.Provider>
  );
};

export const useApp = () => {
  const context = useContext(AppContext);
  if (!context) {
    throw new Error('useApp must be used within an AppProvider');
  }
  return context;
};
