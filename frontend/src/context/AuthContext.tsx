import { createContext, useContext, type ReactNode } from 'react';
import { useAuth } from '../hooks/useAuth';
import type { User } from '../types';

interface AuthContextType {
  user: User | null;
  isLoading: boolean;
  error: string | null;
  /** Screens clear this when the user edits a field, so a stale error does not linger. */
  setError: (error: string | null) => void;
  /** Usernameless — the authenticator picks the credential, so there is nothing to pass. */
  loginWithPasskey: () => Promise<User>;
  registerWithPasskey: (inviteToken: string, username: string) => Promise<User>;
  setupRootWithPasskey: (username: string, setupSecret: string) => Promise<User>;
  /**
   * The password equivalents. `tag` is the full `name#1234`: unlike the passkey
   * path there is no discoverable credential to identify the account, and the
   * username half doubles as the client-side salt.
   *
   * Passwords are stretched in the browser before any of these touch the
   * network, so each takes a few hundred milliseconds and sets `isLoading`.
   */
  loginWithPassword: (tag: string, password: string) => Promise<User>;
  registerWithPassword: (
    inviteToken: string,
    username: string,
    password: string,
  ) => Promise<User>;
  completePasswordReset: (
    token: string,
    username: string,
    password: string,
  ) => Promise<User>;
  logout: () => void;
  updateTermsAccepted: () => void;
  refreshUser: () => Promise<void>;
}

const AuthContext = createContext<AuthContextType | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const auth = useAuth();

  return (
    <AuthContext.Provider value={auth}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuthContext() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuthContext must be used within AuthProvider');
  }
  return context;
}
