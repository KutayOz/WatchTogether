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
   * A regression guard rather than a feature test.
   *
   * This used to also assert zero password fields, on the grounds that BCrypt
   * at work factor 12 costs ~400ms against a 10ms CPU budget and so passwords
   * could not run on this infrastructure at all. The measurement was right and
   * the conclusion was too broad — the work moved to the browser instead, and
   * passwords came back. See worker/src/lib/password.ts.
   *
   * The email half did not come back, and it is the half worth guarding. There
   * is no address column anywhere in the schema, and identity is a handle. An
   * email input appearing here would mean somebody had reintroduced an entire
   * category of stored personal data by accident.
   */
  test('offers no email field — identity is a handle, not an address', async ({ page }) => {
    await page.goto('/login');
    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();

    expect(await page.locator('input[type="email"]').count()).toBe(0);
    await expect(page.getByText(/forgot/i)).toHaveCount(0);
  });

  /**
   * Both doors, in the order that says which one is recommended.
   *
   * Asserted by accessible name rather than by counting `input[type=password]`:
   * the first-run panel contributes a setup-secret input of the same type, so a
   * count is brittle in exactly the configuration where this matters most.
   */
  test('offers a passkey button and a password form, passkey first', async ({ page }) => {
    await page.goto('/login');

    const passkey = page.getByRole('button', { name: /sign in with a passkey/i });
    const password = page.getByRole('button', { name: /sign in with a password/i });

    await expect(passkey).toBeVisible();
    await expect(page.getByLabel('handle:')).toBeVisible();
    await expect(page.getByLabel('password:')).toBeVisible();

    // Passkeys stay the headline; the password form sits under an "or" divider.
    const passkeyBox = await passkey.boundingBox();
    const passwordBox = await password.boundingBox();
    expect(passkeyBox!.y).toBeLessThan(passwordBox!.y);
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
 * The first account cannot be invited by anybody, so an empty database plus a
 * deployment secret is the only way in. Still passkey-only, deliberately:
 * claiming root happens once, at a keyboard, by the person who deployed it.
 *
 * The panel must be invisible from the moment root exists — it is the one place
 * on a public page that accepts a secret.
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
