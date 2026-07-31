import { test, expect } from '@playwright/test';
import {
  mockLoggedOut,
  mockLoggedInUser,
  mockPasskeySignIn,
  mockSetupStatus,
  expectPathname,
  disableAnimations,
} from './helpers';

test.describe('Sign-in screen', () => {
  test.beforeEach(async ({ page }) => {
    // StickerButton with breathe=true wiggles forever; disable so click()
    // doesn't time out on the actionability check.
    await disableAnimations(page);
    // Default state: nobody is signed in. Without this stub the AuthContext
    // initial /me call hangs against the unmocked dev server and PublicRoute
    // delays the render.
    await mockLoggedOut(page);
    // And the instance already has a root account, so the bootstrap panel
    // stays hidden unless a test asks for it.
    await mockSetupStatus(page, true);
  });

  test('renders the passkey sign-in screen', async ({ page }) => {
    await page.goto('/login');

    // Heading + tagline are the load-bearing chrome of this page.
    await expect(page.getByRole('heading', { name: /watchtogether/i })).toBeVisible();
    await expect(page.getByText(/two friends\. one screen/i)).toBeVisible();

    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeEnabled();
    // Accounts exist only by invitation, so there is no sign-up affordance —
    // just the explanation of why.
    await expect(page.getByText(/invite-only/i)).toBeVisible();
  });

  /**
   * A regression guard rather than a feature test. Passwords were removed
   * because BCrypt at work factor 12 costs ~400 ms and a Worker gets 10 ms of
   * CPU, so a password field reappearing here would not be a design regression
   * — it would be a thing that cannot run on this infrastructure at all.
   */
  test('offers nothing to type — no password field, no email field', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();

    expect(await page.locator('input[type="password"]').count()).toBe(0);
    expect(await page.locator('input[type="email"]').count()).toBe(0);
  });

  test('signs in with a passkey and lands in the lobby', async ({ page }) => {
    // Deliberately NOT mockLoggedInUser: that seeds cached-user state, and
    // PublicRoute would redirect away from /login before the button was ever
    // clicked. We want the real shape — arrive signed out, run the ceremony,
    // state flips, redirect.
    await mockPasskeySignIn(page, 'success');

    await page.goto('/login');
    await page.getByRole('button', { name: /sign in with a passkey/i }).click();

    await expectPathname(page, '/');
  });

  test('shows the OOPS burst when the ceremony is cancelled', async ({ page }) => {
    await mockPasskeySignIn(page, 'cancelled');
    await page.goto('/login');

    await page.getByRole('button', { name: /sign in with a passkey/i }).click();

    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(/oops/i)).toBeVisible();
    // Still on /login — a dismissed system sheet is not a failed login.
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('signed-in user visiting /login gets bounced to the lobby', async ({ page }) => {
    // PublicRoute redirects authenticated users away from /login so they don't
    // see a "sign back in" screen for a session they are already in.
    await mockLoggedInUser(page);

    await page.goto('/login');

    await expectPathname(page, '/');
  });
});

/**
 * The first account cannot be invited by anybody, so with no email and no
 * password an empty database plus a deployment secret is the only way in. The
 * panel that does it must be invisible from the moment root exists — it is the
 * one place on a public page that accepts a secret.
 */
test.describe('First-run bootstrap', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
  });

  test('is offered while the instance has no root account', async ({ page }) => {
    await mockSetupStatus(page, false);

    await page.goto('/login');

    await expect(page.getByText(/first run — claim this instance/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /create root account/i })).toBeVisible();
  });

  test('is gone once root exists', async ({ page }) => {
    await mockSetupStatus(page, true);

    await page.goto('/login');
    // Wait for something on the page first, so this is an assertion about a
    // rendered screen rather than about a screen that has not painted yet.
    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();

    await expect(page.getByText(/first run — claim this instance/i)).toHaveCount(0);
  });

  /**
   * The status call failing must hide the panel, not show it. Showing a
   * secret-accepting form because a health check blipped is the worse of the
   * two failure modes.
   */
  test('stays hidden when the status call fails', async ({ page }) => {
    await page.route('**/api/auth/setup/status', (route) => route.abort('failed'));

    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();

    await expect(page.getByText(/first run — claim this instance/i)).toHaveCount(0);
  });
});

test.describe('Signed-out routing', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
  });

  test('anonymous visit to / is redirected to /login', async ({ page }) => {
    // ProtectedRoute kicks anonymous traffic out of the lobby.
    await page.goto('/');
    await expectPathname(page, '/login');
  });

  test('anonymous visit to /session/anything is redirected to /login', async ({ page }) => {
    await page.goto('/session/abc');
    await expectPathname(page, '/login');
  });
});
