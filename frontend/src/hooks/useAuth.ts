import { logger } from '../services/logger';
import { useState, useCallback, useEffect } from 'react';
import { api } from '../services/api';
import { getCachedUser, setAuthData, clearAuthData, updateAuthItem } from '../utils/authStorage';
import type { User } from '../types';

// Auth hook — post-C4
//
// The JWT auth token is now in an HttpOnly cookie set by /api/auth/login. JS
// can't read it. What this hook tracks is just public UI state (displayName,
// role, etc.) for rendering — actual authentication is decided by the server
// on every request based on the cookie.
//
// Boot flow (optimistic + verify):
//   1. Read cached UI fields from localStorage/sessionStorage. If present,
//      optimistically render the app as "logged in".
//   2. Fire /api/auth/me in the background. If 200, refresh local state with
//      authoritative values. If 401, clear local cache and let the router
//      bounce to /login (handled by api.authFetch).
export function useAuth() {
  const [user, setUser] = useState<User | null>(() => {
    const cached = getCachedUser();
    return cached ? {
      email: cached.email,
      displayName: cached.displayName,
      isRootUser: cached.isRootUser,
      isInvitationTicketUsed: cached.isInvitationTicketUsed,
      hasAcceptedTerms: cached.hasAcceptedTerms,
    } : null;
  });
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // On mount, verify the optimistic cached state against the server. If the
  // cookie is gone/expired, api.getMe() throws via the 401 redirect path in
  // authFetch, which clears storage and bounces to /login.
  useEffect(() => {
    if (!user) return; // No cached state — nothing to verify; user is on /login already.
    (async () => {
      try {
        const me = await api.getMe();
        // Server is authoritative — overwrite cache + state with what /me says.
        updateAuthItem('email', me.email);
        updateAuthItem('displayName', me.displayName);
        updateAuthItem('isRootUser', String(me.isRootUser));
        updateAuthItem('isInvitationTicketUsed', String(me.isInvitationTicketUsed));
        updateAuthItem('hasAcceptedTerms', String(me.hasAcceptedTerms));
        setUser({
          email: me.email,
          displayName: me.displayName,
          isRootUser: me.isRootUser,
          isInvitationTicketUsed: me.isInvitationTicketUsed,
          hasAcceptedTerms: me.hasAcceptedTerms,
        });
      } catch {
        // 401 already handled by authFetch (clears + redirects). Other errors
        // (network blip) — leave optimistic state alone, user can retry.
      }
    })();
    // Run once on mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const login = useCallback(async (email: string, password: string, rememberMe: boolean = false) => {
    setIsLoading(true);
    setError(null);
    try {
      // /api/auth/login sets the HttpOnly cookie and returns public user info
      // (no token field any more).
      const response = await api.login(email, password, rememberMe);

      const newUser: User = {
        email: response.email,
        displayName: response.displayName,
        isRootUser: response.isRootUser,
        isInvitationTicketUsed: response.isInvitationTicketUsed,
        hasAcceptedTerms: response.hasAcceptedTerms,
      };

      // Cache UI state. rememberMe still picks between localStorage (persists
      // across browser restarts) and sessionStorage (dies with the tab) — this
      // mirrors the cookie's persistence the server set based on the same flag.
      setAuthData(
        {
          email: response.email,
          displayName: response.displayName,
          isRootUser: response.isRootUser,
          isInvitationTicketUsed: response.isInvitationTicketUsed,
          hasAcceptedTerms: response.hasAcceptedTerms,
        },
        rememberMe
      );

      setUser(newUser);
      return newUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Login failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loginWithPasskey = useCallback(async (email?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      // Dynamic import keeps the @simplewebauthn/browser bundle off the
      // landing-page chunk — only Login users who actually click the
      // passkey button pay the ~15KB cost.
      const { startAuthentication } = await import('@simplewebauthn/browser');
      const options = await api.passkeyBeginAuth(email);
      // SimpleWebAuthn expects an `optionsJSON` wrapper; Fido2NetLib's JSON
      // output matches the WebAuthn spec shape so we pass it through.
      const assertion = await startAuthentication({ optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'] });
      const response = await api.passkeyFinishAuth(assertion);

      const newUser: User = {
        email: response.email,
        displayName: response.displayName,
        isRootUser: response.isRootUser,
        isInvitationTicketUsed: response.isInvitationTicketUsed,
        hasAcceptedTerms: response.hasAcceptedTerms,
      };
      setAuthData(
        {
          email: response.email,
          displayName: response.displayName,
          isRootUser: response.isRootUser,
          isInvitationTicketUsed: response.isInvitationTicketUsed,
          hasAcceptedTerms: response.hasAcceptedTerms,
        },
        true,
      );
      setUser(newUser);
      return newUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Passkey sign-in failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const loginWithGoogle = useCallback(async (idToken: string, invitationLinkToken?: string) => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await api.googleSignIn(idToken, invitationLinkToken);
      const newUser: User = {
        email: response.email,
        displayName: response.displayName,
        isRootUser: response.isRootUser,
        isInvitationTicketUsed: response.isInvitationTicketUsed,
        hasAcceptedTerms: response.hasAcceptedTerms,
      };
      // Google sign-in is treated as "remember me" on the server, so cache
      // in localStorage to match — UI persists across browser restarts.
      setAuthData(
        {
          email: response.email,
          displayName: response.displayName,
          isRootUser: response.isRootUser,
          isInvitationTicketUsed: response.isInvitationTicketUsed,
          hasAcceptedTerms: response.hasAcceptedTerms,
        },
        true,
      );
      setUser(newUser);
      return newUser;
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Google sign-in failed';
      setError(message);
      throw err;
    } finally {
      setIsLoading(false);
    }
  }, []);

  const logout = useCallback(async () => {
    // Tell server to clear the auth cookie BEFORE clearing local cache, so a
    // racing /me call from another tab doesn't see a 401 + redirect-loop while
    // logout is in flight.
    await api.logout();
    clearAuthData();
    setUser(null);
  }, []);

  // Function to update hasAcceptedTerms
  const updateTermsAccepted = useCallback(() => {
    updateAuthItem('hasAcceptedTerms', 'true');
    setUser((prev) => prev ? { ...prev, hasAcceptedTerms: true } : null);
  }, []);

  // Re-pull authoritative user state from /api/auth/me. Called after side-effecting actions
  // (e.g. generating or revoking an invitation link) so the cached User in state/storage doesn't drift.
  const refreshUser = useCallback(async () => {
    try {
      const me = await api.getMe();
      updateAuthItem('email', me.email);
      updateAuthItem('displayName', me.displayName);
      updateAuthItem('isRootUser', String(me.isRootUser));
      updateAuthItem('isInvitationTicketUsed', String(me.isInvitationTicketUsed));
      updateAuthItem('hasAcceptedTerms', String(me.hasAcceptedTerms));
      setUser((prev) => prev ? {
        ...prev,
        email: me.email,
        displayName: me.displayName,
        isRootUser: me.isRootUser,
        isInvitationTicketUsed: me.isInvitationTicketUsed,
        hasAcceptedTerms: me.hasAcceptedTerms,
      } : prev);
    } catch (err) {
      // If /me fails (network blip, 401 already handled by authFetch) we leave local state as-is.
      logger.warn('[Auth] refreshUser failed', err);
    }
  }, []);

  return { user, isLoading, error, login, loginWithGoogle, loginWithPasskey, logout, updateTermsAccepted, refreshUser };
}
