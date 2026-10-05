import React from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

/**
 * Wraps the existing App shell without touching it or any view.
 *
 * While status is 'loading' this renders nothing and, critically, does NOT
 * redirect: redirecting to /login and bouncing back once /me resolves is
 * exactly the flash of the login page we are avoiding.
 */
export const RequireAuth: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const { status, explicitLogout } = useAuth();
  const location = useLocation();

  if (status === 'loading') return null;

  if (status === 'anon') {
    // A deliberate sign-out must not record `from` — the next login should
    // land on the dashboard, not the page the user was on when they logged out.
    // Idle timeouts and expired sessions never set explicitLogout, so they
    // still redirect back to the interrupted page.
    if (explicitLogout) {
      return <Navigate to="/login" replace />;
    }
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};
