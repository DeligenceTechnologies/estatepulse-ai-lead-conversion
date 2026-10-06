/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { Header } from './components/layout/Header';

// Views. Only the sections under active development are imported; the rest
// render ComingSoonView, so their prototype dummy data never reaches the UI.
import { LeadsView } from './components/views/LeadsView';
import { AgentsView } from './components/views/AgentsView';
import { IntegrationsView } from './components/views/IntegrationsView';
import { AISettingsView } from './components/views/AISettingsView';
import { ComingSoonView } from './components/views/ComingSoonView';
import { LeadSourcesView } from './components/views/LeadSourcesView';
import { AppointmentsView } from './components/views/AppointmentsView';
import { CallsView } from './components/views/CallsView';
import { ConversationsView } from './components/views/ConversationsView';
import { FollowUpsView } from './components/views/FollowUpsView';
import { AgentAvailability } from './components/agent/AgentAvailability';

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

  return (
    <div className="flex h-screen bg-slate-950 text-slate-100 overflow-hidden font-sans selection:bg-emerald-500 selection:text-white">
      {/* Structural Sidebar */}
      <Sidebar />

      {/* Main Content Area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        <Header />

        <main className="flex-1 overflow-y-auto custom-scrollbar bg-slate-950/40">
          {activeView === 'dashboard' && <ComingSoonView title="Dashboard" />}
          {activeView === 'leads' && <LeadsView onOpenNewLead={() => setIsNewLeadOpen(true)} />}
          {activeView === 'conversations' && <ConversationsView />}
          {activeView === 'calls' && <CallsView />}
          {activeView === 'appointments' && <AppointmentsView />}
          {activeView === 'followups' && <FollowUpsView />}
          {activeView === 'agents' && <AgentsView />}
          {activeView === 'my_availability' && <AgentAvailability />}
          {activeView === 'integrations' && (
            <IntegrationsView onOpenWebhookTester={() => setIsWebhookTesterOpen(true)} />
          )}
          {activeView === 'lead_sources' && <LeadSourcesView />}
          {activeView === 'ai_settings' && <AISettingsView />}
          {activeView === 'analytics' && <ComingSoonView title="Analytics & ROI" />}
          {activeView === 'landing_page' && <ComingSoonView title="Public Landing Page" />}
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
