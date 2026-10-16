/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Navigate } from 'react-router-dom';
import { AppProvider, useApp, type AppView } from './context/AppContext';
import { useOwnerNav } from './components/layout/Sidebar';
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
import { ImportReviewView } from './components/views/ImportReviewView';
import { AppointmentsView } from './components/views/AppointmentsView';
import { CallsView } from './components/views/CallsView';
import { ConversationsView } from './components/views/ConversationsView';
import { FollowUpsView } from './components/views/FollowUpsView';
import { RolesView } from './components/views/RolesView';
import { SettingsView } from './components/views/SettingsView';
import { CalendarView } from './components/views/CalendarView';
import { AgentAvailability } from './components/agent/AgentAvailability';

// Modals
import { LeadDetailModal } from './components/modals/LeadDetailModal';
import { AgentPreCallModal } from './components/modals/AgentPreCallModal';
import { LiveCallSimulatorModal } from './components/modals/LiveCallSimulatorModal';

const AppContent: React.FC = () => {
  const { activeView, setActiveView } = useApp();
  const navGroups = useOwnerNav();

  return (
    <>
      <AppShell groups={navGroups} activeId={activeView} onNavigate={(id) => setActiveView(id as AppView)}>
        {activeView === 'dashboard' && <DashboardView />}
        {activeView === 'leads' && <LeadsView />}
        {activeView === 'conversations' && <ConversationsView />}
        {activeView === 'calls' && <CallsView />}
        {activeView === 'appointments' && <AppointmentsView />}
        {activeView === 'followups' && <FollowUpsView />}
        {activeView === 'agents' && <AgentsView />}
        {activeView === 'roles' && <RolesView />}
        {activeView === 'team_availability' && <CalendarView section="availability" />}
        {/* Meetings moved into Settings → Calendar; old links still land there. */}
        {activeView === 'meetings' && <Navigate to="/settings?tab=calendar" replace />}
        {activeView === 'my_availability' && <AgentAvailability />}
        {activeView === 'integrations' && <IntegrationsView />}
        {activeView === 'lead_sources' && <LeadSourcesView />}
        {activeView === 'import_review' && <ImportReviewView />}
        {activeView === 'ai_settings' && <AISettingsView />}
        {activeView === 'settings' && <SettingsView />}
        {activeView === 'analytics' && <ComingSoonView title="Analytics & ROI" />}
      </AppShell>

      {/* Global Modals */}
      <LeadDetailModal />
      <AgentPreCallModal />
      <LiveCallSimulatorModal />
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
