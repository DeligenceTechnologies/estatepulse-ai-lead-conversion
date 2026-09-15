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
  const { status } = useAuth();
  const location = useLocation();

  if (status === 'loading') return null;

  if (status === 'anon') {
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  return <>{children}</>;
};
