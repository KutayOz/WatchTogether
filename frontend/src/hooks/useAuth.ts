import { logger } from '../services/logger';
import { useState, useCallback, useEffect } from 'react';
import { api } from '../services/api';
import { getCachedUser, setAuthData, clearAuthData, updateAuthItem } from '../utils/authStorage';
import type { LoginResponse, User } from '../types';

/**
 * Auth state, passkey-only.
 *
 * The JWT is in an HttpOnly cookie that JS cannot read, so what lives here is
 * display state — who the server says you are. Authentication itself is decided
 * server-side on every request.
 *
 * Boot is optimistic then verified: render from the cache so reloading does not
 * flash an empty shell, and reconcile against /api/auth/me in the background.
 * A 401 there is handled inside authFetch, which clears the cache and bounces
 * to /login.
 */
export function useAuth() {
  const [user, setUser] = useState<User | null>(getCachedUser);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /** One place where a server response becomes both cache and state. */
  const adopt = useCallback((response: LoginResponse): User => {
    const next: User = {
      username: response.username,
      discriminator: response.discriminator,
      tag: response.tag,
      isRootUser: response.isRootUser,
      hasAcceptedTerms: response.hasAcceptedTerms,
    };
    setAuthData({
      username: response.username,
      discriminator: response.discriminator,
      tag: response.tag,
      isRootUser: response.isRootUser,
      hasAcceptedTerms: response.hasAcceptedTerms,
    });
    setUser(next);
    return next;
  }, []);

  useEffect(() => {
    // Nothing cached means the user is heading to /login anyway; asking /me
    // would just be a guaranteed 401.
    if (!getCachedUser()) return;
    (async () => {
      try {
        adopt(await api.getMe());
      } catch {
        // 401 is already handled by authFetch. A network blip leaves the
        // optimistic state alone so the app stays usable.
      }
    })();
    // Mount only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Run a WebAuthn ceremony, mapping its failures to something a person can act on.
   *
   * @simplewebauthn/browser is imported dynamically so its ~15KB only loads for
   * someone who actually starts a ceremony, not for every visitor.
   */
  const runCeremony = useCallback(
    async <T,>(fn: () => Promise<T>, fallbackMessage: string): Promise<T> => {
      setIsLoading(true);
      setError(null);
      try {
        return await fn();
      } catch (err) {
        setError(describeWebAuthnError(err, fallbackMessage));
        throw err;
      } finally {
        setIsLoading(false);
      }
    },
    [],
  );

  /**
   * Sign in with no username typed.
   *
   * There is nothing to identify yourself with first — the authenticator offers
   * whichever discoverable credential it holds for this site, and the server
   * learns who you are from the credential id. This is why registration forces
   * `residentKey: "required"`.
   */
  const loginWithPasskey = useCallback(
    () =>
      runCeremony(async () => {
        const { startAuthentication } = await import('@simplewebauthn/browser');
        const options = await api.passkeyBeginAuth();
        const assertion = await startAuthentication({
          optionsJSON: options as Parameters<typeof startAuthentication>[0]['optionsJSON'],
        });
        return adopt(await api.passkeyFinishAuth(assertion));
      }, 'Sign-in failed'),
    [runCeremony, adopt],
  );

  /** Create an account from an invite link. Registering signs you straight in. */
  const registerWithPasskey = useCallback(
    (inviteToken: string, username: string) =>
      runCeremony(async () => {
        const { startRegistration } = await import('@simplewebauthn/browser');
        const options = await api.passkeyBeginInviteRegistration(inviteToken, username);
        const attestation = await startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
        });
        return adopt(await api.passkeyFinishRegistration(attestation, 'First passkey'));
      }, 'Registration failed'),
    [runCeremony, adopt],
  );

  /** First-run bootstrap. Claims root, and only works while nobody holds it. */
  const setupRootWithPasskey = useCallback(
    (username: string, setupSecret: string) =>
      runCeremony(async () => {
        const { startRegistration } = await import('@simplewebauthn/browser');
        const options = await api.setupBegin(username, setupSecret);
        const attestation = await startRegistration({
          optionsJSON: options as Parameters<typeof startRegistration>[0]['optionsJSON'],
        });
        return adopt(await api.setupFinish(attestation));
      }, 'Setup failed'),
    [runCeremony, adopt],
  );

  const logout = useCallback(async () => {
    // Server first: clearing locally before the cookie dies would let a racing
    // /me from another tab redirect-loop while logout is still in flight.
    await api.logout();
    clearAuthData();
    setUser(null);
  }, []);

  const updateTermsAccepted = useCallback(() => {
    updateAuthItem('hasAcceptedTerms', 'true');
    setUser((prev) => (prev ? { ...prev, hasAcceptedTerms: true } : null));
  }, []);

  /** Re-pull authoritative state after something that changes it server-side. */
  const refreshUser = useCallback(async () => {
    try {
      adopt(await api.getMe());
    } catch (err) {
      logger.warn('[Auth] refreshUser failed', err);
    }
  }, [adopt]);

  return {
    user,
    isLoading,
    error,
    setError,
    loginWithPasskey,
    registerWithPasskey,
    setupRootWithPasskey,
    logout,
    updateTermsAccepted,
    refreshUser,
  };
}

/**
 * Turn a WebAuthn rejection into something worth reading.
 *
 * The browser collapses several very different situations into
 * NotAllowedError — cancelled the prompt, let it time out, no credential
 * matched — and its own message is usually empty. Left raw, every one of them
 * surfaces as a blank or cryptic error, which is the single most common way a
 * passkey flow feels broken when it is working correctly.
 */
export function describeWebAuthnError(err: unknown, fallback: string): string {
  if (!(err instanceof Error)) return fallback;

  switch (err.name) {
    case 'NotAllowedError':
      return 'No passkey was used — the prompt was dismissed or timed out.';
    case 'InvalidStateError':
      // Registration only, and specifically means excludeCredentials matched.
      return 'This device already has a passkey for that account.';
    case 'NotSupportedError':
      return 'This browser cannot create passkeys.';
    case 'SecurityError':
      // Almost always a domain mismatch, which for us means the RP ID is wrong.
      return 'Passkeys are unavailable on this address.';
    case 'AbortError':
      return 'Cancelled.';
    default:
      // Server-side failures arrive as ordinary Errors carrying the API's own
      // message, which is already written for a person.
      return err.message || fallback;
  }
}
