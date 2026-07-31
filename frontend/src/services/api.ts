import { API_URL } from '../utils/constants';
import { clearAuthData } from '../utils/authStorage';
import { apiError, readJson } from './http';
import type {
  LoginResponse,
  PasskeyListItem,
  MeResponse,
  IceServerConfig,
  SessionValidation,
  InvitationSlots,
  GenerateLinkResponse,
  ValidateLinkResponse,
  ActiveLinkResponse,
  SessionInviteResponse,
  ValidateSessionInviteResponse,
  JoinWithInviteResponse,
  AdminUser,
  UserTreeResponse,
} from '../types';

// Auth is an HttpOnly cookie issued by the passkey endpoints. Every API call
// uses credentials:'include' so the browser sends the cookie automatically.
// No more Authorization header, no more token in JS-readable storage.
//
// CORS: the backend already runs AllowCredentials() against a specific-origin
// allowlist (not '*' — required when credentials are involved). SameSite=Strict
// on the cookie blocks cross-site CSRF; the backend's Origin check is the
// belt-and-suspenders second layer.

const baseHeaders: HeadersInit = {
  'Content-Type': 'application/json',
};

// Neither the failure nor the success side of a response is guaranteed to be
// JSON — see ./http for why, and for what apiError/readJson do about it. Every
// method below pairs the two with the same fallback wording, so a call fails
// with one recognisable message whichever side went wrong.

// Handle 401 responses by clearing cached UI state and redirecting to login.
// Note: this CAN'T clear the auth cookie (HttpOnly) — only the server can,
// via /api/auth/logout. But once we hit 401, the cookie is presumed expired
// or invalid anyway, so clearing JS-cached display fields is enough.
const handleUnauthorized = () => {
  clearAuthData();
  if (window.location.pathname !== '/login') {
    window.location.href = '/login';
  }
};

// Wrapper for fetch that:
//   1. Sends cookies (credentials:'include')
//   2. Handles 401 by redirecting to login
const authFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  const response = await fetch(url, {
    ...options,
    credentials: 'include',
    headers: { ...baseHeaders, ...(options.headers || {}) },
  });
  if (response.status === 401) {
    handleUnauthorized();
    throw new Error('Session expired. Please sign in again.');
  }
  return response;
};

// For public (no-auth) endpoints — still uses credentials:'include' so that
// after login the cookie is established naturally. Doesn't redirect on 401.
const publicFetch = async (url: string, options: RequestInit = {}): Promise<Response> => {
  return fetch(url, {
    ...options,
    credentials: 'include',
    headers: { ...baseHeaders, ...(options.headers || {}) },
  });
};

export const api = {
  // Auth
  async getMe(): Promise<MeResponse> {
    const response = await authFetch(`${API_URL}/api/auth/me`);
    if (!response.ok) throw await apiError(response, 'Failed to fetch current user');
    return readJson(response, 'Failed to fetch current user');
  },

  // ────────────────── Passkeys ──────────────────
  //
  // The only way in. Passwords and Google sign-in are gone: BCrypt at work
  // factor 12 costs ~400ms against the Workers free plan's 10ms CPU budget, so
  // passwords were not portable, and dropping Google removes an account-linking
  // surface the invite model does not need.

  /**
   * Start creating an account from an invite.
   *
   * Anonymous, unlike the .NET original where both registration endpoints were
   * [Authorize] — a passkey could only ever be *added* to an account that
   * already existed via password. With passwords gone, an invitee holding
   * nothing but a link has to be able to create the account itself.
   */
  async passkeyBeginInviteRegistration(inviteToken: string, username: string): Promise<unknown> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/register/begin`, {
      method: 'POST',
      body: JSON.stringify({ inviteToken, username }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to start registration');
    return readJson(response, 'Failed to start registration');
  },

  /**
   * Finish any registration ceremony — new account or added passkey.
   *
   * One endpoint for both because the server recovers which it is from the
   * challenge, not from the caller. The `label` is what the settings screen
   * shows for this credential.
   */
  async passkeyFinishRegistration(attestation: unknown, label?: string): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/register/finish`, {
      method: 'POST',
      body: JSON.stringify({ response: attestation, ...(label ? { label } : {}) }),
    });
    if (!response.ok) throw await apiError(response, 'Registration failed');
    return readJson(response, 'Registration failed');
  },

  /** Add another passkey to the signed-in account. Finishes via the call above. */
  async passkeyBeginAddition(): Promise<unknown> {
    const response = await authFetch(`${API_URL}/api/auth/passkey/register/add/begin`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to start passkey registration');
    return readJson(response, 'Failed to start passkey registration');
  },

  /**
   * Start sign-in. Takes nothing.
   *
   * Usernameless: the server sends no allowCredentials, so the authenticator
   * offers whichever discoverable credential it holds for this site. Besides
   * being the only option once email is gone, it removes the account
   * enumeration surface that the old optional-email scoping needed a
   * constant-time workaround to paper over.
   */
  async passkeyBeginAuth(): Promise<unknown> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/auth/begin`, { method: 'POST' });
    if (!response.ok) throw await apiError(response, 'Failed to start sign-in');
    return readJson(response, 'Failed to start sign-in');
  },

  async passkeyFinishAuth(assertion: unknown): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/auth/finish`, {
      method: 'POST',
      body: JSON.stringify(assertion),
    });
    if (!response.ok) throw await apiError(response, 'Sign-in failed');
    return readJson(response, 'Sign-in failed');
  },

  async passkeyList(): Promise<{ items: PasskeyListItem[] }> {
    const response = await authFetch(`${API_URL}/api/auth/passkey`);
    if (!response.ok) throw await apiError(response, 'Failed to load passkeys');
    return readJson(response, 'Failed to load passkeys');
  },

  async passkeyRemove(credentialId: string): Promise<void> {
    const response = await authFetch(
      `${API_URL}/api/auth/passkey/${encodeURIComponent(credentialId)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw await apiError(response, 'Failed to remove passkey');
  },

  // ────────────────── First-run bootstrap ──────────────────
  //
  // With no email and no password, the very first account needs a way in that
  // does not depend on an invite from someone who does not exist yet. Gated on
  // both the database being empty and a deployment secret.

  async setupStatus(): Promise<{ isSetupComplete: boolean }> {
    const response = await publicFetch(`${API_URL}/api/auth/setup/status`);
    if (!response.ok) throw await apiError(response, 'Failed to check setup status');
    return readJson(response, 'Failed to check setup status');
  },

  async setupBegin(username: string, setupSecret: string): Promise<unknown> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/setup/begin`, {
      method: 'POST',
      body: JSON.stringify({ username, setupSecret }),
    });
    if (!response.ok) throw await apiError(response, 'Setup failed');
    return readJson(response, 'Setup failed');
  },

  async setupFinish(attestation: unknown): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/setup/finish`, {
      method: 'POST',
      body: JSON.stringify({ response: attestation }),
    });
    if (!response.ok) throw await apiError(response, 'Setup failed');
    return readJson(response, 'Setup failed');
  },

  async logout(): Promise<void> {
    // Errors swallowed: a network blip must not strand the user on logged-in UI
    // when the local cache is about to be cleared regardless.
    try {
      await authFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
    } catch {
      // ignore
    }
  },

  async getAvailableSlots(): Promise<InvitationSlots> {
    const response = await authFetch(`${API_URL}/api/invitation/available-slots`);
    if (!response.ok) throw await apiError(response, 'Failed to get invitation slots');
    return readJson(response, 'Failed to get invitation slots');
  },




  // New link-based invitations
  async generateInviteLink(): Promise<GenerateLinkResponse> {
    const response = await authFetch(`${API_URL}/api/invitation/generate-link`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to generate invite link');
    return readJson(response, 'Failed to generate invite link');
  },

  async validateInviteLink(token: string): Promise<ValidateLinkResponse> {
    const response = await publicFetch(`${API_URL}/api/invitation/validate/${token}`);
    if (!response.ok) throw await apiError(response, 'Failed to validate invite link');
    return readJson(response, 'Failed to validate invite link');
  },

  async getActiveInviteLink(): Promise<ActiveLinkResponse> {
    const response = await authFetch(`${API_URL}/api/invitation/active-link`);
    if (!response.ok) throw await apiError(response, 'Failed to get active link');
    return readJson(response, 'Failed to get active link');
  },

  async revokeInviteLink(): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/invitation/revoke-link`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to revoke invite link');
    return readJson(response, 'Failed to revoke invite link');
  },


  // Session
  async createSession(): Promise<{ sessionId: string }> {
    const response = await authFetch(`${API_URL}/api/session/create`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to create session');
    return readJson(response, 'Failed to create session');
  },

  async validateSession(sessionId: string): Promise<SessionValidation> {
    const response = await authFetch(`${API_URL}/api/session/${sessionId}/validate`);
    if (!response.ok) throw await apiError(response, 'Failed to validate session');
    return readJson(response, 'Failed to validate session');
  },

  async getIceServers(): Promise<IceServerConfig> {
    const response = await authFetch(`${API_URL}/api/session/ice-servers`);
    if (!response.ok) throw await apiError(response, 'Failed to get ICE servers');
    return readJson(response, 'Failed to get ICE servers');
  },

  // Session invites
  async generateSessionInvite(sessionId: string): Promise<SessionInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/${sessionId}/invite`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to generate invite');
    return readJson(response, 'Failed to generate invite');
  },

  async validateSessionInvite(token: string): Promise<ValidateSessionInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/invite/${token}/validate`);
    if (!response.ok) throw await apiError(response, 'Failed to validate invite');
    return readJson(response, 'Failed to validate invite');
  },

  async joinWithSessionInvite(token: string): Promise<JoinWithInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/invite/${token}/join`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to join session');
    return readJson(response, 'Failed to join session');
  },

  // Terms
  async getTerms(): Promise<{ version: string; lastUpdated: string; content: string }> {
    const response = await publicFetch(`${API_URL}/api/terms/current`);
    if (!response.ok) throw await apiError(response, 'Failed to get terms');
    return readJson(response, 'Failed to get terms');
  },

  async acceptTerms(): Promise<{ success: boolean; message: string }> {
    const response = await authFetch(`${API_URL}/api/terms/accept`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to accept terms');
    return readJson(response, 'Failed to accept terms');
  },

  // Admin
  async getAdminUsers(): Promise<AdminUser[]> {
    const response = await authFetch(`${API_URL}/api/admin/users`);
    if (!response.ok) throw await apiError(response, 'Failed to get users');
    return readJson(response, 'Failed to get users');
  },

  async getAdminUserTree(): Promise<UserTreeResponse> {
    const response = await authFetch(`${API_URL}/api/admin/user-tree`);
    if (!response.ok) throw await apiError(response, 'Failed to get user tree');
    return readJson(response, 'Failed to get user tree');
  },



  async deleteAdminUser(id: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/users/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to delete user');
    return readJson(response, 'Failed to delete user');
  },






};
