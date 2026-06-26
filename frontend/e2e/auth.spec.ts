import { test, expect } from '@playwright/test';
import {
  mockLoggedOut,
  mockLoggedInUser,
  mockLoginSuccess,
  mockLoginFailure,
  expectPathname,
  disableAnimations,
} from './helpers';

test.describe('Login screen', () => {
  test.beforeEach(async ({ page }) => {
    // StickerButton with breathe=true wiggles forever; disable so click()
    // doesn't time out on actionability check.
    await disableAnimations(page);
    // Default state: nobody is logged in. Without this stub the AuthContext
    // initial /me call hangs against the unmocked dev server and the
    // PublicRoute logic delays the form render.
    await mockLoggedOut(page);
  });

  // Helper — the page has *two* buttons whose accessible name starts with
  // "Sign in" (the password submit "SIGN IN" and an aria-labelled passkey
  // button). Anchor the regex so only the submit matches; the passkey
  // button's full label is "Sign in with a passkey".
  const signInSubmit = (page: import('@playwright/test').Page) =>
    page.getByRole('button', { name: /^sign in/i, exact: false }).first()
      // Belt-and-braces: also require type=submit so a future refactor that
      // reorders buttons doesn't silently target the passkey one.
      .and(page.locator('button[type="submit"]'));

  test('renders the WatchTogether branded sign-in form', async ({ page }) => {
    await page.goto('/login');

    // Heading + the BETA tag are the load-bearing chrome of this page.
    await expect(page.getByRole('heading', { name: /watchtogether/i })).toBeVisible();
    await expect(page.getByText(/two friends\. one screen/i)).toBeVisible();

    // The form itself — email + password fields + sign-in button.
    await expect(page.getByPlaceholder('you@watchtogether.app')).toBeVisible();
    await expect(page.getByPlaceholder('shhh — keep it secret')).toBeVisible();
    await expect(signInSubmit(page)).toBeVisible();
  });

  test('sign-in button stays disabled until both email and password have content', async ({ page }) => {
    await page.goto('/login');

    const signIn = signInSubmit(page);
    await expect(signIn).toBeDisabled();

    await page.getByPlaceholder('you@watchtogether.app').fill('alice@example.test');
    // Only email filled — still disabled.
    await expect(signIn).toBeDisabled();

    await page.getByPlaceholder('shhh — keep it secret').fill('correct-horse-battery-staple');
    // Both filled — enabled.
    await expect(signIn).toBeEnabled();
  });

  test('successful login redirects to the lobby', async ({ page }) => {
    // Important: DO NOT call mockLoggedInUser here. That helper seeds
    // localStorage with cached-user state, which would make useAuth's
    // optimistic-render path treat us as already logged in — PublicRoute
    // would then redirect from /login *before* we got a chance to fill
    // the form. We want the realistic flow: arrive logged-out, submit
    // the form, login() resolves with the user, state flips, redirect.
    //
    // The login endpoint is the only network mock we need: api.login()
    // returns the response body, useAuth.login() calls setUser(...) with
    // it, and PublicRoute then navigates to "/".
    await mockLoginSuccess(page);

    await page.goto('/login');
    await page.getByPlaceholder('you@watchtogether.app').fill('alice@example.test');
    await page.getByPlaceholder('shhh — keep it secret').fill('correct-horse-battery-staple');
    await signInSubmit(page).click();

    // PublicRoute → Navigate to "/" on user becoming non-null.
    await expectPathname(page, '/');
  });

  test('shows OOPS error after a failed login', async ({ page }) => {
    await mockLoginFailure(page);
    await page.goto('/login');

    await page.getByPlaceholder('you@watchtogether.app').fill('alice@example.test');
    await page.getByPlaceholder('shhh — keep it secret').fill('definitely-wrong');
    await signInSubmit(page).click();

    // The error block has role="alert" and contains an OOPS! burst.
    await expect(page.getByRole('alert')).toBeVisible();
    await expect(page.getByText(/oops/i)).toBeVisible();
    // Still on /login — no redirect.
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('logged-in user visiting /login gets bounced to the lobby', async ({ page }) => {
    // PublicRoute redirects authenticated users away from /login so they
    // don't see a "log back in" form for a session they're already in.
    await mockLoggedInUser(page);

    await page.goto('/login');

    await expectPathname(page, '/');
  });
});

test.describe('Logged-out routing', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
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
