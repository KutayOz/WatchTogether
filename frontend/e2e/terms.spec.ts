import { test, expect, type Page } from '@playwright/test';
import {
  disableAnimations,
  mockLoggedInUser,
  mockLoggedOut,
  mockPasskeySignIn,
  mockSetupStatus,
} from './helpers';

/**
 * The House Rules gate.
 *
 * Two things are covered here, and they used to be separate bugs.
 *
 * Reachability (the "gate opens at all" block at the bottom): the modal used to
 * be a flag on Login and InviteSignup, and Login's copy could never render —
 * PublicRoute sends an authenticated user to "/" the moment sign-in populates
 * them, unmounting Login first. Only brand-new invitees ever saw it, so raising
 * TERMS_VERSION did not in fact re-prompt anyone with an existing account. It
 * is now TermsGate in App.tsx, above the router, covering every entry point.
 *
 * Scroll gating (the first block): the accept button unlatches when the reader
 * has reached the bottom of the terms. "Reached the bottom" has two shapes, and
 * only one of them produces a scroll event:
 *
 *   - the text is taller than the box, and you scroll down through it;
 *   - the text fits in the box, and you are already looking at all of it.
 *
 * The second case shipped broken. hasScrolledToBottom was set only from
 * onScroll, and a box with nothing to scroll never fires one, so on a tall
 * enough window the button stayed disabled forever with the whole document
 * visible above it — no way forward, and the hint still asking for a scroll.
 *
 * Those two use fixture text sized to force one case or the other rather than
 * the real terms at a chosen viewport: the real terms cross the fits/overflows
 * line at around 960px of viewport height, and a test that depended on staying
 * one side of that would rot the moment someone added a paragraph.
 */

const SHORT_TERMS = `# Terms of Service

**Version 1.0**

Be decent to each other.
`;

const LONG_TERMS = `# Terms of Service

**Version 1.0**

${Array.from({ length: 60 }, (_, i) => `Clause ${i + 1}. This paragraph exists to make the document taller than the box.`).join('\n\n')}
`;

/**
 * Walk an invitee from the link to the open modal. The passkey ceremony is
 * stubbed the same way mockPasskeySignIn does it — see the note there for why
 * that proves nothing about WebAuthn and is not meant to.
 */
async function openTermsGate(page: Page, content: string) {
  await disableAnimations(page);

  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        create: async () => {
          const empty = new ArrayBuffer(0);
          return {
            id: 'dGVzdC1jcmVkZW50aWFs',
            rawId: empty,
            type: 'public-key',
            authenticatorAttachment: 'platform',
            response: {
              clientDataJSON: empty,
              attestationObject: empty,
              getTransports: () => ['internal'],
            },
            getClientExtensionResults: () => ({}),
          };
        },
      },
    });
  });

  await page.route('**/api/invitation/validate/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ valid: true, inviterTag: 'alice#0042' }),
    });
  });

  await page.route('**/api/auth/passkey/register/begin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        challenge: 'Y2hhbGxlbmdl',
        rp: { name: 'WatchTogether', id: 'localhost' },
        user: { id: 'dXNlci1pZA', name: 'bea', displayName: 'bea' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60000,
        attestation: 'none',
      }),
    });
  });

  await page.route('**/api/auth/passkey/register/finish', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'bea',
        discriminator: '0007',
        tag: 'bea#0007',
        isRootUser: false,
        // The whole point of this screen: brand-new account, nothing accepted.
        hasAcceptedTerms: false,
      }),
    });
  });

  await page.route('**/api/terms/current', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ version: '1.0', lastUpdated: '2026-01-01', content }),
    });
  });

  await page.goto('/invite/test-invite-token');
  await page.getByRole('textbox').first().fill('bea');
  await page.getByRole('button', { name: /create my passkey/i }).click();

  await expect(page.getByRole('heading', { name: /house rules/i })).toBeVisible();
}

const acceptButton = (page: Page) => page.getByRole('button', { name: /i accept/i });
const scrollHint = (page: Page) => page.getByText(/scroll to the bottom/i);

test.describe('House Rules gate', () => {
  /**
   * The regression. Nothing is scrolled here on purpose — the point is that the
   * button must come up enabled when there is nothing left to scroll.
   */
  test('accepts without scrolling when the whole document already fits', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 1000 });
    await openTermsGate(page, SHORT_TERMS);

    // The last line of the terms is on screen, so the reader is done.
    await expect(page.getByText(/be decent to each other/i)).toBeVisible();
    await expect(acceptButton(page)).toBeEnabled();
    // And the modal must not be asking for a scroll that cannot happen.
    await expect(scrollHint(page)).toBeHidden();
  });

  test('still withholds accept until a scrollable document is read to the end', async ({ page }) => {
    await page.setViewportSize({ width: 1200, height: 700 });
    await openTermsGate(page, LONG_TERMS);

    // Clause 60 is well below the fold: the gate is doing its job.
    await expect(acceptButton(page)).toBeDisabled();
    await expect(scrollHint(page)).toBeVisible();

    await page.getByText(/clause 60\./i).scrollIntoViewIfNeeded();

    await expect(acceptButton(page)).toBeEnabled();
    await expect(scrollHint(page)).toBeHidden();
  });
});

/**
 * Reachability: who actually meets the gate.
 *
 * Every test here would have passed straight through to the lobby before
 * TermsGate existed, because the gate was a flag on two account-creation
 * screens rather than a property of being signed in.
 */
test.describe('House Rules gate is reachable from every entry point', () => {
  const lobbyGreeting = (page: Page) => page.getByText(/ready to hang/i);

  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await page.setViewportSize({ width: 1200, height: 1000 });
    await page.route('**/api/terms/current', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ version: '1.0', lastUpdated: '2026-01-01', content: SHORT_TERMS }),
      });
    });
  });

  /**
   * The PublicRoute bug. Login's own modal never got a frame — sign-in populates
   * the user, PublicRoute redirects to "/", Login unmounts. The user landed in
   * the lobby having accepted nothing.
   */
  test('signing in with terms outstanding lands on the gate, not the lobby', async ({ page }) => {
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
    await mockPasskeySignIn(page, 'success', { hasAcceptedTerms: false });

    await page.goto('/login');
    await page.getByRole('button', { name: /sign in with a passkey/i }).click();

    await expect(page.getByRole('heading', { name: /house rules/i })).toBeVisible();
    await expect(lobbyGreeting(page)).toBeHidden();
  });

  /**
   * The version bump. worker/src/lib/terms.ts says raising TERMS_VERSION
   * re-prompts everyone; this is the case that made that false. A returning user
   * has a valid session and never touches /login, so nothing was watching.
   * Cache says accepted, /me says otherwise — /me wins.
   *
   * The server half of that promise is hasAcceptedCurrentTerms, which compares
   * the accepted version against the current one. This test mocks /me directly,
   * so it pins the client's reaction rather than what makes the server say it —
   * that side is covered in worker/src/lib/terms.test.ts.
   */
  test('a returning session is re-gated when the server says terms are outstanding', async ({ page }) => {
    await mockLoggedInUser(page, { hasAcceptedTerms: true });
    // Registered after mockLoggedInUser so this handler takes precedence.
    await page.route('**/api/auth/me', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          username: 'alice',
          discriminator: '0042',
          tag: 'alice#0042',
          isRootUser: false,
          hasAcceptedTerms: false,
        }),
      });
    });

    await page.goto('/');

    await expect(page.getByRole('heading', { name: /house rules/i })).toBeVisible();
    await expect(lobbyGreeting(page)).toBeHidden();
  });

  /**
   * The gate replaces the route tree instead of floating over it, so the app's
   * controls are genuinely gone rather than merely covered — an overlay would
   * leave them reachable by keyboard behind the backdrop.
   */
  test('holds every route until accepted, then hands the app back', async ({ page }) => {
    await mockLoggedInUser(page, { hasAcceptedTerms: false });

    // Deep-linking past it does not work either.
    await page.goto('/settings');
    await expect(page.getByRole('heading', { name: /house rules/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /create a session/i })).toBeHidden();

    await page.route('**/api/terms/accept', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ success: true, message: 'ok' }),
      });
    });
    await acceptButton(page).click();

    // Accepting navigates nowhere — the route the user was already on comes back.
    await expect(page.getByRole('heading', { name: /house rules/i })).toBeHidden();
    await expect(page).toHaveURL(/\/settings$/);
  });

  /**
   * Refusing has to lead somewhere. The gate replaces the route tree, so the
   * modal is the entire screen — without this the only way out for someone who
   * will not agree to a new version is to clear site data.
   */
  test('declining signs out and returns to the sign-in screen', async ({ page }) => {
    await mockLoggedInUser(page, { hasAcceptedTerms: false });
    await page.route('**/api/auth/logout', async (route) => {
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'Signed out.' }),
      });
    });

    await page.goto('/');
    await expect(page.getByRole('heading', { name: /house rules/i })).toBeVisible();

    await page.getByRole('button', { name: /no thanks — sign out/i }).click();

    await expect(page).toHaveURL(/\/login$/);
    await expect(page.getByRole('heading', { name: /house rules/i })).toBeHidden();
  });
});
