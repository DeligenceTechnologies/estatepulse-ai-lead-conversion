/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { AppProvider, useApp } from './context/AppContext';
import { Sidebar } from './components/layout/Sidebar';
import { AppShell } from './components/layout/AppShell';

// Views. Only the sections under active development are imported; the rest
// render ComingSoonView, so their prototype dummy data never reaches the UI.
import { DashboardView } from './components/views/DashboardView';
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
    <>
      <AppShell sidebar={<Sidebar />}>
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
        {activeView === 'analytics' && <ComingSoonView title="Analytics & ROI" />}
      </AppShell>

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
    </>
  );
};

export default function App() {
  return (
    <AppProvider>
      <AppContent />
    </AppProvider>
  );
}
