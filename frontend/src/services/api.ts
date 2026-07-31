import { API_URL } from '../utils/constants';
import { clearAuthData } from '../utils/authStorage';
import type {
  LoginResponse,
  PasskeyListItem,
  MeResponse,
  IceServerConfig,
  SessionValidation,
  ValidateInvitationResponse,
  RegisterResponse,
  VerifyEmailResponse,
  InvitationSlots,
  Invitation,
  CreateInvitationResponse,
  GenerateLinkResponse,
  ValidateLinkResponse,
  ActiveLinkResponse,
  SessionInviteResponse,
  ValidateSessionInviteResponse,
  JoinWithInviteResponse,
  AdminUser,
  UserTreeResponse,
  AdminInvitation,
  DemoRequestSubmitResponse,
  AdminDemoRequest,
  ApproveDemoRequestResponse,
} from '../types';

// Post-C4: auth is via HttpOnly cookie set by /api/auth/login. Every API call
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

// ────────────────── Error bodies ──────────────────
//
// An error response is NOT guaranteed to be JSON. The API returns
// `{ message }` for every /api/* failure it generates itself, but a large
// class of failures never reaches the API at all: nginx's own 502/504 pages,
// the platform edge timing out an upstream, a proxy rejecting an oversized
// body, a plain-text "not found". Those bodies are HTML or text, and
// `response.json()` on them throws `SyntaxError: Unexpected token '<'`.
//
// That SyntaxError then propagates *in place of* the real failure — the user
// sees a parse error and the actual HTTP status is gone. We hit exactly this
// in Phase 0 on a plain-text "not found" body. safeJson swallows the parse
// failure and returns null so the status always survives to the caller.
const safeJson = async <T>(response: Response): Promise<T | null> => {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

type ApiErrorBody = { message?: string };

// Human-readable stand-in for a status code, used when the body carried no
// usable message. Covers what an edge or proxy actually emits ahead of the API
// (502/503/504/413) alongside the ordinary 4xx/5xx the API could return with
// no body of its own.
const describeStatus = (status: number): string => {
  switch (status) {
    case 400: return 'bad request';
    case 401: return 'not signed in';
    case 403: return 'not permitted';
    case 404: return 'not found';
    case 408: return 'request timed out';
    case 409: return 'conflict';
    case 413: return 'request too large';
    case 429: return 'too many requests — try again shortly';
    case 500: return 'server error';
    case 502: return 'bad gateway — the server may be restarting';
    case 503: return 'service unavailable — the server may be restarting';
    case 504: return 'gateway timeout';
    default:
      if (status >= 500) return `server error ${status}`;
      if (status >= 400) return `request rejected (${status})`;
      return `unexpected response (${status})`;
  }
};

// Builds the Error to throw for a failed response. Prefers the API's own
// `message`; otherwise falls back to the caller's wording plus what the
// transport said, so the HTTP status reaches the UI even when the body was
// unparseable. Never throws — an unusable body degrades to the fallback.
const apiError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await safeJson<ApiErrorBody>(response);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  return new Error(message || `${fallback} (${describeStatus(response.status)})`);
};

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
    return response.json();
  },

  async login(email: string, password: string, rememberMe: boolean = false): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/login`, {
      method: 'POST',
      body: JSON.stringify({ email, password, rememberMe }),
    });
    if (!response.ok) throw await apiError(response, 'Login failed');
    return response.json();
  },

  // ────────────────── Passkeys (WebAuthn) ──────────────────

  async passkeyBeginRegistration(): Promise<unknown> {
    const response = await authFetch(`${API_URL}/api/auth/passkey/register/begin`, { method: 'POST' });
    if (!response.ok) throw await apiError(response, 'Failed to start passkey registration');
    return response.json();
  },

  async passkeyFinishRegistration(attestation: unknown, label: string): Promise<{ label: string }> {
    const response = await authFetch(`${API_URL}/api/auth/passkey/register/finish`, {
      method: 'POST',
      body: JSON.stringify({ response: attestation, label }),
    });
    if (!response.ok) throw await apiError(response, 'Passkey registration failed');
    return response.json();
  },

  async passkeyBeginAuth(email?: string): Promise<unknown> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/auth/begin`, {
      method: 'POST',
      body: JSON.stringify({ email: email ?? null }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to start passkey authentication');
    return response.json();
  },

  async passkeyFinishAuth(assertion: unknown): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/passkey/auth/finish`, {
      method: 'POST',
      body: JSON.stringify(assertion),
    });
    if (!response.ok) throw await apiError(response, 'Passkey authentication failed');
    return response.json();
  },

  async passkeyList(): Promise<{ items: PasskeyListItem[] }> {
    const response = await authFetch(`${API_URL}/api/auth/passkey`);
    if (!response.ok) throw await apiError(response, 'Failed to load passkeys');
    return response.json();
  },

  async passkeyRemove(credentialIdBase64Url: string): Promise<void> {
    const response = await authFetch(
      `${API_URL}/api/auth/passkey/${encodeURIComponent(credentialIdBase64Url)}`,
      { method: 'DELETE' },
    );
    if (!response.ok) throw await apiError(response, 'Failed to remove passkey');
  },

  async googleSignIn(idToken: string, invitationLinkToken?: string): Promise<LoginResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/google`, {
      method: 'POST',
      // Send the invitation link only when present — the backend treats Google
      // sign-in as invitation-gated for new accounts, but ignores the token
      // for existing users (matched by GoogleId or email).
      body: JSON.stringify({ idToken, ...(invitationLinkToken ? { invitationLinkToken } : {}) }),
    });
    if (!response.ok) throw await apiError(response, 'Google sign-in failed');
    return response.json();
  },

  async logout(): Promise<void> {
    // Tell the server to clear the auth cookie. The server-side handler is
    // idempotent — safe even if already expired. Errors are swallowed so a
    // network blip doesn't leave the user stuck on the logged-in UI.
    try {
      await authFetch(`${API_URL}/api/auth/logout`, { method: 'POST' });
    } catch {
      // ignore
    }
  },

  async validateInvitation(token: string): Promise<ValidateInvitationResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/invitation/${token}`);
    if (!response.ok) throw await apiError(response, 'Failed to validate invitation');
    return response.json();
  },

  async register(invitationToken: string, displayName: string, password: string): Promise<RegisterResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/register`, {
      method: 'POST',
      body: JSON.stringify({ invitationToken, displayName, password }),
    });
    if (!response.ok) throw await apiError(response, 'Registration failed');
    return response.json();
  },

  async verifyEmailByToken(token: string): Promise<VerifyEmailResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/verify-email/${encodeURIComponent(token)}`);
    if (!response.ok) throw await apiError(response, 'Verification failed');
    return response.json();
  },

  async resendVerification(email: string): Promise<{ message: string }> {
    const response = await publicFetch(`${API_URL}/api/auth/resend-verification`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to resend verification');
    return response.json();
  },

  // Invitations
  async getAvailableSlots(): Promise<InvitationSlots> {
    const response = await authFetch(`${API_URL}/api/invitation/available-slots`);
    if (!response.ok) throw await apiError(response, 'Failed to get invitation slots');
    return response.json();
  },

  async createInvitation(email: string): Promise<CreateInvitationResponse> {
    const response = await authFetch(`${API_URL}/api/invitation/create`, {
      method: 'POST',
      body: JSON.stringify({ email }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to create invitation');
    return response.json();
  },

  async getMyInvitations(): Promise<Invitation[]> {
    const response = await authFetch(`${API_URL}/api/invitation/my-invitations`);
    if (!response.ok) throw await apiError(response, 'Failed to get invitations');
    return response.json();
  },

  async revokeInvitation(id: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/invitation/${id}/revoke`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to revoke invitation');
    return response.json();
  },

  // New link-based invitations
  async generateInviteLink(): Promise<GenerateLinkResponse> {
    const response = await authFetch(`${API_URL}/api/invitation/generate-link`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to generate invite link');
    return response.json();
  },

  async validateInviteLink(token: string): Promise<ValidateLinkResponse> {
    const response = await publicFetch(`${API_URL}/api/invitation/validate/${token}`);
    if (!response.ok) throw await apiError(response, 'Failed to validate invite link');
    return response.json();
  },

  async getActiveInviteLink(): Promise<ActiveLinkResponse> {
    const response = await authFetch(`${API_URL}/api/invitation/active-link`);
    if (!response.ok) throw await apiError(response, 'Failed to get active link');
    return response.json();
  },

  async revokeInviteLink(): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/invitation/revoke-link`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to revoke invite link');
    return response.json();
  },

  async registerWithLink(linkToken: string, email: string, displayName: string, password: string): Promise<RegisterResponse> {
    const response = await publicFetch(`${API_URL}/api/auth/register-with-link`, {
      method: 'POST',
      body: JSON.stringify({ linkToken, email, displayName, password }),
    });
    if (!response.ok) throw await apiError(response, 'Registration failed');
    return response.json();
  },

  // Session
  async createSession(): Promise<{ sessionId: string }> {
    const response = await authFetch(`${API_URL}/api/session/create`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to create session');
    return response.json();
  },

  async validateSession(sessionId: string): Promise<SessionValidation> {
    const response = await authFetch(`${API_URL}/api/session/${sessionId}/validate`);
    if (!response.ok) throw await apiError(response, 'Failed to validate session');
    return response.json();
  },

  async getIceServers(): Promise<IceServerConfig> {
    const response = await authFetch(`${API_URL}/api/session/ice-servers`);
    if (!response.ok) throw await apiError(response, 'Failed to get ICE servers');
    return response.json();
  },

  // Session invites
  async generateSessionInvite(sessionId: string): Promise<SessionInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/${sessionId}/invite`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to generate invite');
    return response.json();
  },

  async validateSessionInvite(token: string): Promise<ValidateSessionInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/invite/${token}/validate`);
    if (!response.ok) throw await apiError(response, 'Failed to validate invite');
    return response.json();
  },

  async joinWithSessionInvite(token: string): Promise<JoinWithInviteResponse> {
    const response = await authFetch(`${API_URL}/api/session/invite/${token}/join`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to join session');
    return response.json();
  },

  // Terms
  async getTerms(): Promise<{ version: string; lastUpdated: string; content: string }> {
    const response = await publicFetch(`${API_URL}/api/terms/current`);
    if (!response.ok) throw await apiError(response, 'Failed to get terms');
    return response.json();
  },

  async acceptTerms(): Promise<{ success: boolean; message: string }> {
    const response = await authFetch(`${API_URL}/api/terms/accept`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to accept terms');
    return response.json();
  },

  // Admin
  async getAdminUsers(): Promise<AdminUser[]> {
    const response = await authFetch(`${API_URL}/api/admin/users`);
    if (!response.ok) throw await apiError(response, 'Failed to get users');
    return response.json();
  },

  async getAdminUserTree(): Promise<UserTreeResponse> {
    const response = await authFetch(`${API_URL}/api/admin/user-tree`);
    if (!response.ok) throw await apiError(response, 'Failed to get user tree');
    return response.json();
  },

  async getAdminInvitations(): Promise<AdminInvitation[]> {
    const response = await authFetch(`${API_URL}/api/admin/invitations`);
    if (!response.ok) throw await apiError(response, 'Failed to get invitations');
    return response.json();
  },

  async updateAdminUser(id: string, data: { displayName?: string; email?: string; isEmailVerified?: boolean }): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/users/${id}`, {
      method: 'PUT',
      body: JSON.stringify(data),
    });
    if (!response.ok) throw await apiError(response, 'Failed to update user');
    return response.json();
  },

  async deleteAdminUser(id: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/users/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to delete user');
    return response.json();
  },

  async deleteAdminInvitation(id: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/invitations/${id}`, {
      method: 'DELETE',
    });
    if (!response.ok) throw await apiError(response, 'Failed to delete invitation');
    return response.json();
  },

  // Demo requests (public submit)
  async submitDemoRequest(email: string, displayName: string, message?: string): Promise<DemoRequestSubmitResponse> {
    const response = await publicFetch(`${API_URL}/api/demo-requests`, {
      method: 'POST',
      body: JSON.stringify({ email, displayName, message: message?.trim() || null }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to submit demo request');
    return response.json();
  },

  // Demo requests (admin)
  async getAdminDemoRequests(): Promise<AdminDemoRequest[]> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests`);
    if (!response.ok) throw await apiError(response, 'Failed to get demo requests');
    return response.json();
  },

  async approveAdminDemoRequest(id: string): Promise<ApproveDemoRequestResponse> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests/${id}/approve`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to approve demo request');
    return response.json();
  },

  async rejectAdminDemoRequest(id: string, reason?: string): Promise<{ message: string }> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests/${id}/reject`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason?.trim() || null }),
    });
    if (!response.ok) throw await apiError(response, 'Failed to reject demo request');
    return response.json();
  },

  async resendAdminDemoRequest(id: string): Promise<ApproveDemoRequestResponse> {
    const response = await authFetch(`${API_URL}/api/admin/demo-requests/${id}/resend`, {
      method: 'POST',
    });
    if (!response.ok) throw await apiError(response, 'Failed to resend invitation');
    return response.json();
  },
};
