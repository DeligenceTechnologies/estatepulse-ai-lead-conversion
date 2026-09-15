import React from 'react';
import { Route, Routes } from 'react-router-dom';
import App from './App';
import { LoginPage } from './components/auth/LoginPage';
import { RequireAuth } from './components/auth/RequireAuth';
import { SignupPage } from './components/auth/SignupPage';

/**
 * The router operates only at the auth boundary. Everything inside the shell
 * still navigates through AppContext's activeView, so no view is touched and
 * App.tsx is rendered as-is.
 */
export const Root: React.FC = () => (
  <Routes>
    <Route path="/login" element={<LoginPage />} />
    <Route path="/signup" element={<SignupPage />} />
    <Route
      path="*"
      element={
        <RequireAuth>
          <App />
        </RequireAuth>
      }
    />
  </Routes>
);
