import { test, expect } from '@playwright/test';
import { mockLoggedOut, mockLoggedInUser, trackChunkRequests } from './helpers';

/**
 * Code-split smoke. These tests verify the bundle-size optimization is
 * actually doing its job at runtime — landing on /login must NOT pull
 * down session-only chunks (signalr, webrtc-adapter), and navigating
 * to other routes must trigger the expected per-route chunk fetch.
 *
 * Sensitive to:
 *   - The dev build, which doesn't chunk like the prod build. We run
 *     against the dev server (vite dev) per playwright.config.ts —
 *     Vite's dev mode DOES emit per-route dynamic imports as separate
 *     modules, just not minified. So the assertion "chunk X was
 *     requested" still works as long as we match by the human-readable
 *     prefix Vite uses for dynamic-imported source files.
 *   - Manual chunks naming. If someone renames an entry in the
 *     manualChunks() function in vite.config.ts, the assertions here
 *     have to follow. That's a feature — the test forces the rename
 *     to be intentional.
 */

test.describe('Code splitting at runtime', () => {
  // In dev mode Vite serves modules with /src/components/... paths,
  // not /assets/<chunk>.js. We adjust the request tracker to capture
  // either form so the assertions work in both dev and preview-of-prod.
  function trackAllJsRequests(page: import('@playwright/test').Page) {
    const seen: string[] = [];
    page.on('request', (req) => {
      const url = req.url();
      if (url.endsWith('.js') || url.includes('.tsx') || url.includes('.ts?')) {
        seen.push(url);
      }
    });
    return {
      includesAny: (patterns: string[]) =>
        patterns.some((p) => seen.some((url) => url.includes(p))),
      includesAll: (patterns: string[]) =>
        patterns.every((p) => seen.some((url) => url.includes(p))),
      // Useful for debugging when an assertion fails.
      dump: () => [...seen],
    };
  }

  test('landing on /login does NOT load session-only modules', async ({ page }) => {
    // This is the load-bearing assertion of the route-split work:
    // a visitor that just opens the login page should not be paying
    // for SignalR, webrtc-adapter, or any /Session/ source code.
    await mockLoggedOut(page);
    const tracker = trackAllJsRequests(page);

    await page.goto('/login');
    await page.waitForLoadState('networkidle');

    // No session-only deps should be in the network log.
    expect(
      tracker.includesAny(['@microsoft/signalr', 'webrtc-adapter', '/components/Session/']),
      `unexpected session-only module loaded on /login. seen: ${tracker.dump().slice(0, 30).join(', ')}`,
    ).toBeFalsy();
  });

  test('preview of prod bundle: /login pulls auth chunk but not session chunk', async ({ page, baseURL }) => {
    // This test is the strongest signal — it runs against the dev server
    // in a way that exercises the dynamic-import boundary. We check that
    // the lazy() in App.tsx actually defers the SessionRoom module.
    await mockLoggedOut(page);
    const tracker = trackAllJsRequests(page);

    await page.goto(`${baseURL}/login`);
    await page.waitForLoadState('networkidle');

    // Auth components must be loaded (we're rendering Login).
    expect(
      tracker.includesAny(['/components/Login/Login']),
      'Login.tsx should be loaded on /login',
    ).toBeTruthy();

    // Session components must NOT be loaded.
    expect(
      tracker.includesAny(['/components/Session/SessionRoom']),
      'SessionRoom.tsx must not be loaded until the user enters /session/*',
    ).toBeFalsy();
  });

  test('lobby loads its own module but not session modules', async ({ page }) => {
    await mockLoggedInUser(page);
    const tracker = trackAllJsRequests(page);

    await page.goto('/');
    await page.waitForLoadState('networkidle');

    expect(
      tracker.includesAny(['/components/Lobby/Lobby']),
      'Lobby.tsx should be loaded when landing on /',
    ).toBeTruthy();

    expect(
      tracker.includesAny(['/components/Session/SessionRoom']),
      'SessionRoom.tsx must still be deferred from the lobby',
    ).toBeFalsy();
  });
});
