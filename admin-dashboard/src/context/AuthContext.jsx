import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import { api, session as sessionStore, setUnauthenticatedHandler } from '../api/client';

const AuthContext = createContext(null);

/**
 * Holds the signed in administrator. The session survives a page reload via
 * localStorage; if the refresh token has since been revoked, the first API call
 * clears it and returns the user to the sign in screen.
 */
export function AuthProvider({ children }) {
  const [admin, setAdmin] = useState(() => {
    const stored = sessionStore.read();
    return stored ? stored.admin : null;
  });
  const [ready, setReady] = useState(false);

  const signOut = useCallback(() => {
    sessionStore.clear();
    setAdmin(null);
  }, []);

  useEffect(() => {
    setUnauthenticatedHandler(signOut);
  }, [signOut]);

  // Confirm a restored session is still good before showing the dashboard.
  useEffect(() => {
    let cancelled = false;
    if (!sessionStore.read()) {
      setReady(true);
      return () => {};
    }
    api
      .me()
      .then((response) => {
        if (cancelled) return;
        setAdmin(response.admin);
        const stored = sessionStore.read();
        if (stored) sessionStore.write({ ...stored, admin: response.admin });
      })
      .catch(() => {
        if (!cancelled) signOut();
      })
      .finally(() => {
        if (!cancelled) setReady(true);
      });
    return () => {
      cancelled = true;
    };
  }, [signOut]);

  const signIn = useCallback(async (email, password) => {
    const response = await api.login(email, password);
    sessionStore.write({ admin: response.admin, tokens: response.tokens });
    setAdmin(response.admin);
    return response.admin;
  }, []);

  const value = useMemo(
    () => ({
      admin,
      ready,
      signIn,
      signOut,
      isSuperAdmin: admin ? admin.role === 'Super Admin' : false,
    }),
    [admin, ready, signIn, signOut]
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) throw new Error('useAuth must be used inside AuthProvider');
  return context;
}
