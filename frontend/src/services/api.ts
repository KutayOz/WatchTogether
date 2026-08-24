import { API_URL } from '../utils/constants';
import { clearAuthData } from '../utils/authStorage';
import { apiError, readJson } from './http';
import type {
  LoginResponse,
  PasskeyListItem,
  PasswordCredential,
  PasswordResetStatus,
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
  DemoRequestSubmitResponse,
  AdminDemoRequest,
  ApproveDemoRequestResponse,
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
  // The recommended way in, and for a long time the only one. Google sign-in is
  // gone for good — it was an account-linking surface the invite model does not
  // need — but passwords came back; see the section below for how.

  /**
   * Start creating an account from an invite.
   *
   * Anonymous, unlike the .NET original where both registration endpoints were
   * [Authorize] — a passkey could only ever be *added* to an account that
   * already existed via password. An invitee holding nothing but a link has to
   * be able to create the account itself.
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

  // ────────────────── Passwords ──────────────────
  //
  // Every method here takes a `clientKey`, never a password. The browser
  // stretches the password with PBKDF2 before anything is sent — see
  // hooks/usePasswordField.ts and @shared/password for why — so this module
  // stays what it has always been: transport, holding no credential logic of
  // its own, the same way it never touches @simplewebauthn/browser.
  //
  // If you find yourself adding a `password` parameter to one of these, the
  // derivation has been skipped and the plaintext is about to go over the wire.

  async passwordSignup(
    inviteToken: string,
    username: string,
    credential: PasswordCredential,
  ): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/password/signup`, {
      method: 'POST',
      body: JSON.stringify({ inviteToken, username, ...credential }),
    });
    if (!response.ok) throw await apiError(response, 'Registration failed');
    return readJson(response, 'Registration failed');
  },

  /** Takes the full `name#1234` handle — a bare username is ambiguous. */
  async passwordLogin(tag: string, credential: PasswordCredential): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/password/login`, {
      method: 'POST',
      body: JSON.stringify({ tag, ...credential }),
    });
    if (!response.ok) throw await apiError(response, 'Sign-in failed');
    return readJson(response, 'Sign-in failed');
  },

  /**
   * Check a reset link before asking for a new password.
   *
   * Returns the username on success because the client cannot derive a key
   * without it — it is the salt.
   */
  async passwordResetStatus(token: string): Promise<PasswordResetStatus> {
    const response = await publicFetch(
      `${API_URL}/api/auth/password/reset/${encodeURIComponent(token)}`,
    );
    if (!response.ok) throw await apiError(response, 'Failed to check that reset link');
    return readJson(response, 'Failed to check that reset link');
  },

  async passwordResetComplete(
    token: string,
    credential: PasswordCredential,
  ): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/password/reset`, {
      method: 'POST',
      body: JSON.stringify({ token, ...credential }),
    });
    if (!response.ok) throw await apiError(response, 'Could not set that password');
    return readJson(response, 'Could not set that password');
  },

  /**
   * Root only. Mints a single-use link, shown once and never recoverable.
   *
   * The only recovery path there is: no email address exists anywhere in this
   * system, so a forgotten password cannot be self-served. It also works on an
   * account that has never had a password, which is how a passkey-only user
   * gets one.
   */
  async adminResetPassword(userId: string): Promise<{ resetUrl: string; expiresAt: number }> {
    const response = await authFetch(
      `${API_URL}/api/admin/users/${encodeURIComponent(userId)}/password/reset`,
      { method: 'POST' },
    );
    if (!response.ok) throw await apiError(response, 'Failed to create a reset link');
    return readJson(response, 'Failed to create a reset link');
  },

  // ────────────────── First-run bootstrap ──────────────────
  //
  // The very first account needs a way in that does not depend on an invite
  // from someone who does not exist yet. Gated on both the database being empty
  // and a deployment secret. Passkey-only: claiming root is a one-time action
  // at a keyboard, so the password path was not worth a second endpoint.

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
  /**
   * The Worker answers `{ users, truncated }`, not a bare array.
   *
   * This used to `return readJson(...)` straight through while declaring
   * `AdminUser[]`, so the admin Users tab rendered "USERS ()" and an empty
   * table on every load — the object satisfied the type assertion (readJson
   * validates that a body parsed, not that it matches T) and `.map` was never
   * reached because `.length` was undefined. Nothing surfaced an error.
   */
  async getAdminUsers(): Promise<AdminUser[]> {
    const response = await authFetch(`${API_URL}/api/admin/users`);
    if (!response.ok) throw await apiError(response, 'Failed to get users');
    const body = await readJson<{ users: AdminUser[] }>(response, 'Failed to get users');
    return body.users ?? [];
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

  // ────────────────── Demo requests ──────────────────

  /**
   * Ask for an invite without holding one. The only write in this file that
   * needs no session — the caller has no account, which is the point.
   */
  async submitDemoRequest(
    email: string,
    displayName: string,
    message?: string,
  ): Promise<DemoRequestSubmitResponse> {
    const response = await publicFetch(`${API_URL}/api/demo-requests`, {
      method: 'POST',
      body: JSON.stringify({ email, displayName, message: message?.trim() || null }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to send the request');
    return readJson(response, 'Failed to send the request');
  },

  /** Envelope-unwrapping, for the reason spelled out over getAdminUsers. */
  async getAdminDemoRequests(): Promise<AdminDemoRequest[]> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests`);
    if (!response.ok) throw await apiError(response, 'Failed to get demo requests');
    const body = await readJson<{ requests: AdminDemoRequest[] }>(
      response,
      'Failed to get demo requests',
    );
    return body.requests ?? [];
  },

  /**
   * Approve, and receive the invite link that answers the request.
   *
   * The link is in this response and nowhere else — the server keeps only its
   * hash, exactly like the password reset link. Whatever shows it has to be the
   * thing that lets root copy it.
   */
  async approveAdminDemoRequest(id: string): Promise<ApproveDemoRequestResponse> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests/${id}/approve`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to approve the request');
    return readJson(response, 'Failed to approve the request');
  },

  async rejectAdminDemoRequest(id: string, reason?: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason?.trim() || null }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to close the request');
    return readJson(response, 'Failed to close the request');
  },






};
