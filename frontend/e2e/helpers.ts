import { Page, expect } from '@playwright/test';

/**
 * Test-side helpers for stubbing the API boundary.
 *
 * The frontend talks to the Worker through fetch() against the same origin
 * (`vite dev` proxies /api → `wrangler dev` in real life, but in E2E we
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
  username: string;
  discriminator: string;
  /** `username#1234` — the server precomputes it so the two cannot drift. */
  tag: string;
  isRootUser?: boolean;
  hasAcceptedTerms?: boolean;
}

/**
 * Stand the user up as authenticated for the lifetime of the test.
 *
 * useAuth() does NOT call /me unless there's a cached user in storage
 * (optimistic-render pattern — see useAuth.ts line ~47). So an /api/auth/me
 * mock by itself isn't enough: we also have to pre-seed localStorage with
 * the same keys getCachedUser() looks for. addInitScript runs in the page
 * context *before* any application script, so the React init() sees the
 * cache as if the user had already signed in on a prior visit.
 *
 * The /me mock is still useful — useAuth's background-verify path fires
 * after the initial render and overwrites state from this response. Without
 * the mock, /me would hit the dev server (or fail), potentially clearing
 * the optimistic state via the 401 redirect path.
 *
 * There is no token to fake. The JWT lives in an HttpOnly cookie that JS
 * cannot write, which is the point — everything seeded here is public UI
 * state that grants nothing on its own.
 */
export async function mockLoggedInUser(page: Page, overrides: Partial<MeShape> = {}) {
  const user: MeShape = {
    username: 'alice',
    discriminator: '0042',
    tag: 'alice#0042',
    isRootUser: false,
    hasAcceptedTerms: true,
    ...overrides,
  };
  // 1) Seed storage so the optimistic-render path turns the user on. These are
  //    exactly the AUTH_KEYS in authStorage.ts; 'username' is the sentinel
  //    getCachedUser() requires before it will return a user at all.
  await page.addInitScript((u) => {
    localStorage.setItem('username', u.username);
    localStorage.setItem('discriminator', u.discriminator);
    localStorage.setItem('tag', u.tag);
    localStorage.setItem('isRootUser', String(u.isRootUser ?? false));
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

/**
 * Whether the instance already has a root account.
 *
 * /login calls this on mount and shows the first-run bootstrap form only when
 * it answers false, so every test touching that screen has to pin it — an
 * unmocked call reaches the dev server and the panel's visibility becomes a
 * property of whatever is in the local database.
 */
export async function mockSetupStatus(page: Page, isSetupComplete: boolean) {
  await page.route('**/api/auth/setup/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isSetupComplete }),
    });
  });
}

/**
 * Drive a passkey sign-in to a chosen outcome.
 *
 * Two halves, because a passkey ceremony has two:
 *
 *   - The *authenticator* half is stubbed by replacing navigator.credentials.
 *     Chromium does expose a virtual authenticator over CDP, but it only
 *     answers a challenge for a credential it holds, and minting one means
 *     hand-rolling a PKCS#8 key whose signature the mocked server half would
 *     then ignore anyway. The stub is the honest version of the same fiction.
 *   - The *server* half is stubbed with page.route().
 *
 * So this covers the screen's wiring — button → ceremony → state → redirect,
 * and the failure path back to the OOPS burst. It deliberately proves nothing
 * about WebAuthn verification itself; that lives in the Worker's own suite
 * (worker/src/routes/passkey.test.ts), where it runs against real crypto.
 */
export async function mockPasskeySignIn(
  page: Page,
  outcome: 'success' | 'cancelled',
  user: Partial<MeShape> = {},
) {
  await page.addInitScript((shouldSucceed) => {
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: async () => {
          if (!shouldSucceed) {
            // What a real authenticator throws when the user dismisses the
            // system sheet. useAuth maps it to the message the burst shows.
            throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
          }
          // @simplewebauthn/browser reads these fields off the credential and
          // re-encodes them; the shapes matter, the bytes do not, because the
          // /finish mock below never looks at them.
          const empty = new ArrayBuffer(0);
          return {
            id: 'dGVzdC1jcmVkZW50aWFs',
            rawId: empty,
            type: 'public-key',
            authenticatorAttachment: 'platform',
            response: {
              clientDataJSON: empty,
              authenticatorData: empty,
              signature: empty,
              userHandle: empty,
            },
            getClientExtensionResults: () => ({}),
          };
        },
      },
    });
  }, outcome === 'success');

  await page.route('**/api/auth/passkey/auth/begin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        challenge: 'Y2hhbGxlbmdl',
        rpId: 'localhost',
        timeout: 60000,
        userVerification: 'preferred',
        // Usernameless: the authenticator picks from its discoverable
        // credentials rather than being handed a list.
        allowCredentials: [],
      }),
    });
  });

  await page.route('**/api/auth/passkey/auth/finish', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        discriminator: '0042',
        tag: 'alice#0042',
        isRootUser: false,
        hasAcceptedTerms: true,
        ...user,
      }),
    });
  });
}

/**
 * Drive a password sign-in to a chosen outcome.
 *
 * Simpler than its passkey counterpart in one way and slower in another. There
 * is no ceremony, so navigator.credentials does not have to be faked — only the
 * server half is stubbed. But the page still runs the real 600,000-iteration
 * PBKDF2 before it calls anything, because that happens in utils/password.ts
 * and is not mocked here. Expect a few hundred milliseconds per sign-in, and
 * more on a shared CI runner.
 *
 * If a spec using this starts flaking on a slow machine, raise its timeout.
 * Lowering the iteration count would be mocking away the thing under test.
 */
export async function mockPasswordSignIn(
  page: Page,
  outcome: 'success' | 'wrong-password' | 'locked',
  user: Partial<MeShape> = {},
) {
  await page.route('**/api/auth/password/login', async (route) => {
    if (outcome === 'wrong-password') {
      // One string for unknown handle, no password set, and wrong password —
      // see routes/password.ts. Anything else is an enumeration oracle.
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'That handle and password do not match.' }),
      });
      return;
    }

    if (outcome === 'locked') {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '900' },
        body: JSON.stringify({
          message: 'Too many attempts. Try again in 15 minutes.',
          retryAfterSeconds: 900,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        discriminator: '0042',
        tag: 'alice#0042',
        isRootUser: false,
        hasAcceptedTerms: true,
        ...user,
      }),
    });
  });
}

/** Stub the probe /reset/:token makes on mount, and the redemption after it. */
export async function mockPasswordReset(
  page: Page,
  validity: 'valid' | 'used' | 'expired' | 'not_found',
  username = 'alice',
) {
  await page.route('**/api/auth/password/reset/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        validity === 'valid'
          ? { valid: true, username, tag: `${username}#0042` }
          : { valid: false, reason: validity },
      ),
    });
  });

  // Distinct from the probe above: same prefix, no token segment, POST only.
  await page.route('**/api/auth/password/reset', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username,
        discriminator: '0042',
        tag: `${username}#0042`,
        isRootUser: false,
        hasAcceptedTerms: true,
      }),
    });
  });
}

/** Stub the invite-link check /invite/:token makes on mount. */
export async function mockInviteLink(page: Page, valid = true, inviterTag = 'bob#0007') {
  await page.route('**/api/invitation/validate/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        valid ? { valid: true, inviterTag } : { valid: false, message: 'That invite is not valid.' },
      ),
    });
  });
}

/** Stub invite-scoped password signup. */
export async function mockPasswordSignup(page: Page, username = 'ada') {
  await page.route('**/api/auth/password/signup', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username,
        discriminator: '0042',
        tag: `${username}#0042`,
        isRootUser: false,
        hasAcceptedTerms: true,
      }),
    });
  });
}

/** Track every JS chunk the page downloads. Useful for the code-split
 *  assertions — "did landing on /login pull in the session chunk?" */
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
