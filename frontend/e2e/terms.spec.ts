import { test, expect, type Page } from '@playwright/test';
import { disableAnimations } from './helpers';

/**
 * The House Rules gate.
 *
 * Driven through /invite/:token rather than /login, because that is the only
 * route that actually reaches the modal: a brand-new account has never accepted
 * anything, and InviteSignup is not wrapped in PublicRoute. (Login's copy of
 * the modal is unreachable — PublicRoute bounces to "/" the moment sign-in
 * populates the user, before showTermsModal can render. Separate bug.)
 *
 * The accept button unlatches when the reader has reached the bottom of the
 * terms. "Reached the bottom" has two shapes, and only one of them produces a
 * scroll event:
 *
 *   - the text is taller than the box, and you scroll down through it;
 *   - the text fits in the box, and you are already looking at all of it.
 *
 * The second case shipped broken. hasScrolledToBottom was set only from
 * onScroll, and a box with nothing to scroll never fires one, so on a tall
 * enough window the button stayed disabled forever with the whole document
 * visible above it — no way forward, and the hint still asking for a scroll.
 *
 * Both tests use fixture text sized to force one case or the other rather than
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
