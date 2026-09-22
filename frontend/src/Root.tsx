import React from 'react';
import { Route, Routes } from 'react-router-dom';
import App from './App';
import { AgentApp } from './components/agent/AgentApp';
import { LoginPage } from './components/auth/LoginPage';
import { RequireAuth } from './components/auth/RequireAuth';
import { SignupPage } from './components/auth/SignupPage';
import { useAuth } from './context/AuthContext';

/**
 * Which application a signed-in person gets.
 *
 * An agent gets their own shell rather than the owner's with pieces hidden: the
 * owner's sidebar is a list of things an agent may not do, so subtracting from
 * it would leave every future view one forgotten check away from leaking. App
 * itself is untouched, which is what makes the owner experience provably
 * unchanged by this split.
 *
 * Role comes from AuthContext, which reads it from GET /api/auth/me on every
 * restore — never from anything the browser stores.
 */
const RoleShell: React.FC = () => {
  const { role } = useAuth();
  return role === 'agent' ? <AgentApp /> : <App />;
};

/**
 * The router operates only at the auth boundary. Everything inside the owner
 * shell still navigates through AppContext's activeView, so no view is touched
 * and App.tsx is rendered as-is.
 */
export const Root: React.FC = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route
      path="*"
      element={
        <RequireAuth>
          <RoleShell />
        </RequireAuth>
      }
    />
  </Routes>
);
