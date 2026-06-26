import { Page, expect } from '@playwright/test';

/**
 * Test-side helpers for stubbing the API boundary.
 *
 * The frontend talks to the backend through fetch() against the same origin
 * (Vite dev server proxies /api → backend in real life, but in E2E we
 * intercept the request before it even leaves the page). All routes here are
 * relative to baseURL.
 *
 * Convention: each mock function returns the Promise<void> from page.route()
 * so callers can `await` them in a `beforeEach`.
 */

/** Body shape returned by the real /api/auth/me endpoint. Kept here as a
 *  loose-typed copy so we don't pull frontend type imports into the test
 *  config (Vite + Playwright TS roots are separate). */
interface MeShape {
  email: string;
  displayName: string;
  isRootUser?: boolean;
  hasAcceptedTerms?: boolean;
  isInvitationTicketUsed?: boolean;
}

/**
 * Stand the user up as authenticated for the lifetime of the test.
 *
 * useAuth() does NOT call /me unless there's a cached user in storage
 * (optimistic-render pattern — see useAuth.ts line ~37). So an /api/auth/me
 * mock by itself isn't enough: we also have to pre-seed localStorage with
 * the same keys getCachedUser() looks for. addInitScript runs in the page
 * context *before* any application script, so the React init() sees the
 * cache as if the user had already logged in on a prior visit.
 *
 * The /me mock is still useful — useAuth's background-verify path fires
 * after the initial render and overwrites state from this response. Without
 * the mock, /me would hit the dev server (or fail), potentially clearing
 * the optimistic state via the 401 redirect path.
 */
export async function mockLoggedInUser(page: Page, overrides: Partial<MeShape> = {}) {
  const user: MeShape = {
    email: 'alice@example.test',
    displayName: 'Alice',
    isRootUser: false,
    hasAcceptedTerms: true,
    isInvitationTicketUsed: false,
    ...overrides,
  };
  // 1) Seed storage so the optimistic-render path turns the user on.
  await page.addInitScript((u) => {
    // Match the exact keys useAuth + getCachedUser read in authStorage.ts.
    // 'displayName' is the sentinel — its presence flips "logged in".
    localStorage.setItem('rememberMe', 'true');
    localStorage.setItem('displayName', u.displayName);
    localStorage.setItem('email', u.email);
    localStorage.setItem('isRootUser', String(u.isRootUser ?? false));
    localStorage.setItem('isInvitationTicketUsed', String(u.isInvitationTicketUsed ?? false));
    localStorage.setItem('hasAcceptedTerms', String(u.hasAcceptedTerms ?? true));
  }, user);
  // 2) Mock /me so the background-verify confirms (instead of clearing state).
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(user),
    });
  });
}

/** Logged-out: /me returns 401 → AuthContext stays null → ProtectedRoute
 *  bounces to /login. The default for tests that exercise the auth screens. */
export async function mockLoggedOut(page: Page) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
}

/** Successful login. Body matches ExtendedLoginResponse on the backend. */
export async function mockLoginSuccess(page: Page) {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        token: 'fake-jwt-token',
        email: 'alice@example.test',
        displayName: 'Alice',
        isRootUser: false,
        isInvitationTicketUsed: false,
        hasAcceptedTerms: true,
      }),
    });
  });
}

/** Generic login failure — the real backend returns 401 with a single
 *  generic message (constant-time defense against email enumeration). */
export async function mockLoginFailure(page: Page, status = 401) {
  await page.route('**/api/auth/login', async (route) => {
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({ message: 'Invalid email or password' }),
    });
  });
}

/** Track every JS chunk the page downloads. Useful for the code-split
 *  assertions — "did landing on /login pull in signalr-*.js?" */
export function trackChunkRequests(page: Page) {
  const downloaded: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    // We care about /assets/*.js files. Vite emits chunks with hashed
    // names like /assets/auth-NL9fgHYe.js, so we extract the prefix
    // (before the first hyphen) as the chunk name.
    const match = url.match(/\/assets\/([^/]+)\.js(?:\?|$)/);
    if (match) downloaded.push(match[1]);
  });
  return {
    /** Return the set of unique chunk-name prefixes seen so far. */
    chunks: () => new Set(downloaded.map((n) => n.split('-')[0])),
  };
}

/** Quick wait — page is fully idle (no in-flight requests, no transitions).
 *  More reliable than fixed timeouts when working with React Suspense + lazy. */
export async function waitForFullyLoaded(page: Page) {
  await page.waitForLoadState('networkidle');
}

/**
 * Kill all CSS animations + transitions for the page lifetime.
 *
 * Why: StickerButton with `breathe` runs a constant keyframe that makes
 * the button bounding box wiggle a few pixels. Playwright's actionability
 * check refuses to click an "unstable" element, and the breathe never
 * stops — so the test eventually times out. This injects a stylesheet at
 * init time that turns animations + transitions off via duration:0.
 *
 * Tradeoff: we lose the ability to assert *visually* that animations are
 * playing. That's fine for smoke tests — the animation is decorative.
 * Any test that needs to observe an animation should opt out of this.
 */
export async function disableAnimations(page: Page) {
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
    // Defer to DOMContentLoaded so <head> exists. Init scripts run before
    // any document — appending now to documentElement is the safe bet.
    if (document.head) {
      document.head.appendChild(style);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style), { once: true });
    }
  });
}

/** Assert the page is on the expected pathname (ignoring querystring). */
export async function expectPathname(page: Page, expected: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}
