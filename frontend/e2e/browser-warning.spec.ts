import { test, expect } from '@playwright/test';
import { mockLoggedOut, disableAnimations } from './helpers';

/**
 * BrowserWarning is the first thing every visitor sees if their browser
 * is unsupported. The detection logic runs synchronously on page load
 * and the warning either replaces the app (blocking) or sits above it
 * (dismissible). Both paths are testable from Playwright by spoofing
 * the user-agent at the context level.
 */

test.describe('Browser compatibility warning', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
  });

  test('does not show on a modern Chrome', async ({ page }) => {
    // The Playwright default Desktop Chrome UA is current — no warning expected.
    await page.goto('/login');

    // The warning sits at the top of the document; if absent the login
    // form heading is the first major H1-equivalent visible.
    await expect(page.getByRole('heading', { name: /watchtogether/i })).toBeVisible();

    // No "browser" warning text anywhere on the page.
    await expect(page.getByText(/unsupported browser|please upgrade|update your browser/i))
      .toHaveCount(0);
  });

  // The dismissal round-trip used to be asserted here. It could not fail: the
  // fixture seeded a key nothing reads ('wt:browserWarning:dismissed:Chrome'
  // rather than 'watchtogether_dismissed_warnings'), and Playwright's Chrome
  // raises no warning to dismiss in the first place, so the one assertion —
  // that the heading renders — was true either way. It now lives in
  // src/utils/browserDetection.test.ts, where the storage contract is the thing
  // under test and a broken key fails.
});
