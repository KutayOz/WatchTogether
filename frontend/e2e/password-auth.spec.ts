import { test, expect, type Page } from '@playwright/test';
import {
  mockLoggedOut,
  mockSetupStatus,
  mockPasswordSignIn,
  mockPasswordReset,
  mockInviteLink,
  mockPasswordSignup,
  expectPathname,
  disableAnimations,
} from './helpers';

/**
 * The password half of the auth screens.
 *
 * Every spec here runs the real 600,000-iteration derivation in the page — it
 * lives in utils/password.ts and nothing mocks it — so each sign-in costs a few
 * hundred milliseconds. That is the design working, not a slow test: if these
 * flake on a shared runner, raise the timeout rather than the iteration count.
 *
 * What is *not* covered here: whether the server actually verifies anything.
 * The API is stubbed. Verification, lockout and the enumeration-parity
 * guarantee are the Worker suite's job, against real crypto and real D1
 * (worker/src/routes/password.test.ts).
 */

// Exact, because "Repeat password" and the "Show password" toggle both
// contain the word and a substring match would find three things — and
// narrowed to text inputs, because on the signup screen the sign-in method
// radio is also called "Password".
const handleField = (page: Page) => page.getByLabel('Handle');
const passwordField = (page: Page) =>
  page.getByLabel('Password', { exact: true }).and(page.locator('input:not([type="radio"])'));
const repeatField = (page: Page) => page.getByLabel('Repeat password');
const usernameField = (page: Page) => page.getByLabel('Username');

test.describe('Password sign-in', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
  });

  test('signs in with a handle and a password', async ({ page }) => {
    await mockPasswordSignIn(page, 'success');
    await page.goto('/login');

    await handleField(page).fill('alice#0042');
    await passwordField(page).fill('orbital-teapot-42');
    await page.getByRole('button', { name: /sign in with a password/i }).click();

    await expectPathname(page, '/');
  });

  test('says the server’s sentence on a wrong password and stays put', async ({ page }) => {
    await mockPasswordSignIn(page, 'wrong-password');
    await page.goto('/login');

    await handleField(page).fill('alice#0042');
    await passwordField(page).fill('not-the-right-one');
    await page.getByRole('button', { name: /sign in with a password/i }).click();

    // The server's own sentence, passed through rather than reworded — and
    // deliberately the same one an unknown handle gets.
    await expect(page.getByRole('alert')).toContainText(/that handle and password do not match/i);
    expect(new URL(page.url()).pathname).toBe('/login');
  });

  test('passes the lockout message through with its wait time intact', async ({ page }) => {
    await mockPasswordSignIn(page, 'locked');
    await page.goto('/login');

    await handleField(page).fill('alice#0042');
    await passwordField(page).fill('orbital-teapot-42');
    await page.getByRole('button', { name: /sign in with a password/i }).click();

    await expect(page.getByText(/too many attempts.*15 minutes/i)).toBeVisible();
  });

  test('will not submit until the handle carries its number', async ({ page }) => {
    await page.goto('/login');
    const submit = page.getByRole('button', { name: /sign in with a password/i });

    await passwordField(page).fill('orbital-teapot-42');

    // A bare username is ambiguous, and the username half is also the
    // client-side salt — so a missing discriminator has to be caught here
    // rather than becoming a 400 that reads like a wrong password.
    await handleField(page).fill('alice');
    await expect(submit).toBeDisabled();

    // Leaving the field says why, instead of only greying the button.
    await passwordField(page).focus();
    await expect(page.getByText(/add the number after the #/i)).toBeVisible();

    await handleField(page).fill('alice#0042');
    await expect(submit).toBeEnabled();
    await expect(page.getByText(/add the number after the #/i)).toHaveCount(0);
  });

  test('reveals and re-hides the password', async ({ page }) => {
    await page.goto('/login');

    const field = passwordField(page);
    await field.fill('orbital-teapot-42');
    await expect(field).toHaveAttribute('type', 'password');

    await page.getByRole('button', { name: /show password/i }).click();
    await expect(field).toHaveAttribute('type', 'text');

    await page.getByRole('button', { name: /hide password/i }).click();
    await expect(field).toHaveAttribute('type', 'password');
  });
});

test.describe('Signing up with a password', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
    await mockInviteLink(page, true);
  });

  test('offers both methods, with a passkey preselected', async ({ page }) => {
    await page.goto('/invite/some-token');

    await expect(page.getByRole('radio', { name: /passkey/i })).toBeChecked();
    await expect(page.getByRole('radio', { name: /password/i })).not.toBeChecked();
    // Nothing password-shaped until it is asked for.
    await expect(passwordField(page)).toHaveCount(0);
  });

  test('names who sent the invite', async ({ page }) => {
    await page.goto('/invite/some-token');
    await expect(page.getByRole('heading', { name: /bob#0007 saved you a seat/i })).toBeVisible();
  });

  test('creates an account with a password', async ({ page }) => {
    await mockPasswordSignup(page, 'ada');
    await page.goto('/invite/some-token');

    await usernameField(page).fill('ada');
    await page.getByRole('radio', { name: /password/i }).check();
    await passwordField(page).fill('orbital-teapot-42');
    await repeatField(page).fill('orbital-teapot-42');

    await page.getByRole('button', { name: /^create account$/i }).click();

    await expectPathname(page, '/');
  });

  test('rejects a weak password without asking the server', async ({ page }) => {
    let signupCalls = 0;
    await page.route('**/api/auth/password/signup', async (route) => {
      signupCalls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });

    await page.goto('/invite/some-token');
    await usernameField(page).fill('ada');
    await page.getByRole('radio', { name: /password/i }).check();
    await passwordField(page).fill('short');
    await repeatField(page).fill('short');

    await expect(page.getByText(/at least 12 characters/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^create account$/i })).toBeDisabled();
    expect(signupCalls).toBe(0);
  });

  test('will not submit two passwords that disagree', async ({ page }) => {
    await page.goto('/invite/some-token');
    await usernameField(page).fill('ada');
    await page.getByRole('radio', { name: /password/i }).check();
    await passwordField(page).fill('orbital-teapot-42');
    await repeatField(page).fill('orbital-teapot-43');

    await expect(page.getByText(/those two don.t match/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /^create account$/i })).toBeDisabled();
  });

  test('says out loud that a forgotten password cannot be recovered', async ({ page }) => {
    await page.goto('/invite/some-token');
    await page.getByRole('radio', { name: /password/i }).check();

    // The one consequence of this choice the person making it cannot undo.
    await expect(page.getByText(/no password reset here/i)).toBeVisible();
  });

  test('switching back to a passkey takes the password fields away', async ({ page }) => {
    await page.goto('/invite/some-token');
    await page.getByRole('radio', { name: /password/i }).check();
    await expect(passwordField(page)).toBeVisible();

    await page.getByRole('radio', { name: /passkey/i }).check();
    await expect(passwordField(page)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /create account with a passkey/i })).toBeVisible();
  });
});

test.describe('Password reset links', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
  });

  test('sets a new password and signs the user straight in', async ({ page }) => {
    await mockPasswordReset(page, 'valid', 'alice');
    await page.goto('/reset/some-token');

    // The handle comes from the server's probe, never from anything typed —
    // the username is the salt, so a guess would derive an unusable key.
    await expect(page.getByText('alice#0042')).toBeVisible();

    await passwordField(page).fill('brand-new-passphrase');
    await repeatField(page).fill('brand-new-passphrase');
    await page.getByRole('button', { name: /^set password$/i }).click();

    await expectPathname(page, '/');
  });

  test('explains a spent link', async ({ page }) => {
    await mockPasswordReset(page, 'used');
    await page.goto('/reset/some-token');

    await expect(page.getByText(/already been used/i)).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0);
  });

  test('explains an expired link', async ({ page }) => {
    await mockPasswordReset(page, 'expired');
    await page.goto('/reset/some-token');

    await expect(page.getByText(/has expired/i)).toBeVisible();
    await expect(passwordField(page)).toHaveCount(0);
  });
});
