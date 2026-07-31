// Cached UI identity.
//
// SECURITY MODEL:
//   - The JWT lives in an HttpOnly cookie. JS cannot read it, so token theft
//     via XSS is not possible.
//   - What is stored here is public UI state (username, tag, role) so boot does
//     not flash an empty shell. None of it grants anything server-side — that is
//     solely the cookie's job.
//   - /api/auth/me is the source of truth; this is an optimistic hint that gets
//     overwritten on every boot.
//
// "Remember me" is gone along with passwords. It used to choose between
// localStorage and sessionStorage to mirror a cookie whose Max-Age the login
// request controlled. The Worker now issues one cookie lifetime for every
// sign-in, so honouring a stored preference would actively desynchronise the
// two: a sessionStorage cache dies with the tab while the cookie lives on, and
// the app would render logged-out for a user whose session is perfectly valid.
// One storage, matching one cookie.
//
// Accessed as window.localStorage rather than the bare global: modern Node
// ships its own experimental localStorage, which shadows the DOM one under a
// test environment and throws on every method unless the process was started
// with --localstorage-file. Naming the window explicitly means this code reads
// the same object in a browser and in a test.

const AUTH_KEYS = ['username', 'discriminator', 'tag', 'isRootUser', 'hasAcceptedTerms'] as const;

export interface CachedUser {
  username: string;
  discriminator: string;
  tag: string;
  isRootUser: boolean;
  hasAcceptedTerms: boolean;
}

export function setAuthData(data: CachedUser): void {
  window.localStorage.setItem('username', data.username);
  window.localStorage.setItem('discriminator', data.discriminator);
  window.localStorage.setItem('tag', data.tag);
  window.localStorage.setItem('isRootUser', String(data.isRootUser));
  window.localStorage.setItem('hasAcceptedTerms', String(data.hasAcceptedTerms));
}

/**
 * Clear the JS-readable hint state.
 *
 * This cannot clear the HttpOnly cookie — only the server can, via
 * POST /api/auth/logout. api.logout() does both, in the order that leaves no
 * live token behind.
 */
export function clearAuthData(): void {
  for (const key of AUTH_KEYS) {
    window.localStorage.removeItem(key);
    // Swept too: sessions cached under the old remember-me split would
    // otherwise linger in sessionStorage forever, invisible to every other
    // function here.
    window.sessionStorage.removeItem(key);
  }
  window.localStorage.removeItem('rememberMe');
}

export function updateAuthItem(key: string, value: string): void {
  if (window.localStorage.getItem('username')) window.localStorage.setItem(key, value);
}

/**
 * The cached user, if any.
 *
 * Returning something does NOT mean the server still considers the session
 * valid — only the cookie and /me can answer that. Treat it as optimistic and
 * verify.
 */
export function getCachedUser(): CachedUser | null {
  const username = window.localStorage.getItem('username');
  if (!username) return null;

  const tag = window.localStorage.getItem('tag');
  const discriminator = window.localStorage.getItem('discriminator');
  // A half-written cache is worse than none: it renders a user with a blank
  // handle. Drop it and let /me repopulate.
  if (!tag || !discriminator) {
    clearAuthData();
    return null;
  }

  return {
    username,
    discriminator,
    tag,
    isRootUser: window.localStorage.getItem('isRootUser') === 'true',
    hasAcceptedTerms: window.localStorage.getItem('hasAcceptedTerms') === 'true',
  };
}
