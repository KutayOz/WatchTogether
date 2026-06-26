// Auth storage — post-C4
//
// SECURITY MODEL:
//   - The JWT auth token lives in an HttpOnly cookie set by /api/auth/login.
//   - JS *cannot* read that cookie. Token theft via XSS is no longer possible.
//   - What's stored here is *public UI state* (displayName, role, etc.) for
//     optimistic boot rendering. None of it grants any privilege server-side
//     — that's solely the cookie's job.
//   - The /api/auth/me endpoint is the source of truth; the storage is just
//     a cached hint so the app doesn't flash an empty-state shell on reload.
//
// The "remember me" preference still lives here (it controls the cookie's
// Max-Age via the login request body), and we still split between localStorage
// and sessionStorage based on that preference — for consistency with how the
// cookie behaves (persistent vs session).

const AUTH_KEYS = [
  'email',
  'displayName',
  'isRootUser',
  'isInvitationTicketUsed',
  'hasAcceptedTerms',
] as const;

const REMEMBER_ME_KEY = 'rememberMe';

/**
 * Check if user has "remember me" enabled
 */
export function isRememberMeEnabled(): boolean {
  return localStorage.getItem(REMEMBER_ME_KEY) === 'true';
}

/**
 * Get the appropriate storage based on remember me setting
 */
function getStorage(): Storage {
  return isRememberMeEnabled() ? localStorage : sessionStorage;
}

/**
 * Get auth item from storage (checks both storages for existing sessions)
 */
export function getAuthItem(key: string): string | null {
  // First check the preferred storage
  const storage = getStorage();
  const value = storage.getItem(key);
  if (value) return value;

  // Fallback: check the other storage (for migration/edge cases)
  const otherStorage = isRememberMeEnabled() ? sessionStorage : localStorage;
  return otherStorage.getItem(key);
}

/**
 * Set all auth items and remember me preference. No `token` field any more —
 * the server sets an HttpOnly cookie. We only cache the UI display fields.
 */
export function setAuthData(
  data: {
    email: string;
    displayName: string;
    isRootUser: boolean;
    isInvitationTicketUsed: boolean;
    hasAcceptedTerms: boolean;
  },
  rememberMe: boolean
): void {
  // First clear any existing auth data from both storages
  clearAuthData();

  // Set remember me preference in localStorage (must persist to know which storage to use)
  localStorage.setItem(REMEMBER_ME_KEY, String(rememberMe));

  // Now set data in the appropriate storage
  const storage = rememberMe ? localStorage : sessionStorage;
  storage.setItem('email', data.email);
  storage.setItem('displayName', data.displayName);
  storage.setItem('isRootUser', String(data.isRootUser));
  storage.setItem('isInvitationTicketUsed', String(data.isInvitationTicketUsed));
  storage.setItem('hasAcceptedTerms', String(data.hasAcceptedTerms));
}

/**
 * Clear all auth data from both storages.
 *
 * IMPORTANT: this only clears the JS-readable hint state. The HttpOnly auth
 * cookie can only be cleared by the server — call POST /api/auth/logout to
 * actually invalidate the session. (api.logout() does both in the right order.)
 */
export function clearAuthData(): void {
  for (const key of AUTH_KEYS) {
    localStorage.removeItem(key);
    sessionStorage.removeItem(key);
  }
  localStorage.removeItem(REMEMBER_ME_KEY);
}

/**
 * Update a single auth item (preserves storage location)
 */
export function updateAuthItem(key: string, value: string): void {
  // Update in whichever storage has the displayName (our "is logged in" sentinel)
  if (localStorage.getItem('displayName')) {
    localStorage.setItem(key, value);
  } else if (sessionStorage.getItem('displayName')) {
    sessionStorage.setItem(key, value);
  }
}

/**
 * Get cached user info if present. Note: returning data here does NOT mean the
 * server still considers the user authenticated — only the cookie + /me check
 * can answer that. Callers should treat this as an *optimistic* hint and
 * verify via api.getMe() on boot.
 */
export function getCachedUser(): {
  email: string;
  displayName: string;
  isRootUser: boolean;
  isInvitationTicketUsed: boolean;
  hasAcceptedTerms: boolean;
} | null {
  // Check both storages for displayName (used as the "have any cached user" sentinel)
  const displayName = localStorage.getItem('displayName') || sessionStorage.getItem('displayName');
  if (!displayName) return null;

  // Determine which storage has the data
  const storage = localStorage.getItem('displayName') ? localStorage : sessionStorage;
  const email = storage.getItem('email');
  if (!email) {
    clearAuthData();
    return null;
  }

  return {
    email,
    displayName,
    isRootUser: storage.getItem('isRootUser') === 'true',
    isInvitationTicketUsed: storage.getItem('isInvitationTicketUsed') === 'true',
    hasAcceptedTerms: storage.getItem('hasAcceptedTerms') === 'true',
  };
}
