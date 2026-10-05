import React from 'react';
import { Route, Routes } from 'react-router-dom';
import App from './App';
import { AgentApp } from './components/agent/AgentApp';
import { LoginPage } from './components/auth/LoginPage';
import { RequireAuth } from './components/auth/RequireAuth';
import { SignupPage } from './components/auth/SignupPage';
import { LandingPage } from './components/public/LandingPage';
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
 * `/` is the one path with two answers: the public landing page for a visitor,
 * and the application for someone signed in.
 *
 * Done here rather than by moving the app to `/app` because `/` is already the
 * post-login target both auth pages navigate to — so neither of them, nor the
 * `from` redirect in RequireAuth, needs to know this page exists.
 *
 * 'loading' renders nothing on purpose, exactly as RequireAuth does: showing the
 * landing page for the moment it takes /me to answer would flash marketing copy
 * at a user who is already signed in.
 */
const Home: React.FC = () => {
  const { status } = useAuth();
  if (status === 'loading') return null;
  return status === 'authed' ? <RoleShell /> : <LandingPage />;
};

/**
 * These routes decide only the auth boundary. Section paths (/dashboard,
 * /leads, ...) all fall through `*` to the role's shell, which maps the path to
 * a view itself: AppContext's activeView for an owner, AgentApp for an agent.
 */
export const Root: React.FC = () => (
  <Routes>
    <Route path="/" element={<Home />} />
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
