/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';

// Views
import { DashboardView } from './components/views/DashboardView';
import { LeadsView } from './components/views/LeadsView';
import { ConversationsView } from './components/views/ConversationsView';
import { CallsView } from './components/views/CallsView';
import { AppointmentsView } from './components/views/AppointmentsView';
import { FollowUpsView } from './components/views/FollowUpsView';
import { AgentsView } from './components/views/AgentsView';
import { IntegrationsView } from './components/views/IntegrationsView';
import { AISettingsView } from './components/views/AISettingsView';
import { AnalyticsView } from './components/views/AnalyticsView';
import { PublicLandingPageView } from './components/views/PublicLandingPageView';
import { LeadSourcesView } from './components/views/LeadSourcesView';

// Modals
import { LeadDetailModal } from './components/modals/LeadDetailModal';
import { AgentPreCallModal } from './components/modals/AgentPreCallModal';
import { LiveCallSimulatorModal } from './components/modals/LiveCallSimulatorModal';
import { NewLeadModal } from './components/modals/NewLeadModal';
import { WebhookSimulatorModal } from './components/modals/WebhookSimulatorModal';

const AppContent: React.FC = () => {
  const { activeView } = useApp();

  const [isNewLeadOpen, setIsNewLeadOpen] = useState(false);
  const [isWebhookTesterOpen, setIsWebhookTesterOpen] = useState(false);

  // If the user wants to view the public conversion landing page (PRD Section 59)
  if (activeView === 'landing_page') {
    return (
      <>
        <PublicLandingPageView />
        {/* Global modals for interactive preview */}
        <LiveCallSimulatorModal />
        <LeadDetailModal />
        <AgentPreCallModal />
      </>
    );
  }

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-white">
      {/* Structural Sidebar */}
      <Sidebar
        onOpenNewLead={() => setIsNewLeadOpen(true)}
        onOpenWebhookTester={() => setIsWebhookTesterOpen(true)}
      />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header 
          onOpenNewLead={() => setIsNewLeadOpen(true)}
          onOpenWebhookTester={() => setIsWebhookTesterOpen(true)}
        />

        <main className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950/40">
          {activeView === 'dashboard' && <DashboardView />}
          {activeView === 'leads' && <LeadsView onOpenNewLead={() => setIsNewLeadOpen(true)} />}
          {activeView === 'conversations' && <ConversationsView />}
          {activeView === 'calls' && <CallsView />}
          {activeView === 'appointments' && <AppointmentsView />}
          {activeView === 'followups' && <FollowUpsView />}
          {activeView === 'agents' && <AgentsView />}
          {activeView === 'integrations' && (
            <IntegrationsView onOpenWebhookTester={() => setIsWebhookTesterOpen(true)} />
          )}
          {activeView === 'lead_sources' && <LeadSourcesView />}
          {activeView === 'ai_settings' && <AISettingsView />}
          {activeView === 'analytics' && <AnalyticsView />}
        </main>
      </div>

      {/* Global Modals */}
      <LeadDetailModal />
      <AgentPreCallModal />
      <LiveCallSimulatorModal />
      <NewLeadModal 
        isOpen={isNewLeadOpen} 
        onClose={() => setIsNewLeadOpen(false)} 
      />
      <WebhookSimulatorModal 
        isOpen={isWebhookTesterOpen} 
        onClose={() => setIsWebhookTesterOpen(false)} 
      />
    </div>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
