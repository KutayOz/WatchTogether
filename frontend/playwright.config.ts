import { defineConfig, devices } from '@playwright/test';

/**
 * Playwright config for WatchTogether's frontend smoke suite.
 *
 * What we're testing here:
 *   - Frontend behavior in real Chromium with the real bundle.
 *   - API calls are mocked at the network boundary (page.route()) so the
 *     suite doesn't need MongoDB + the backend to be running.
 *   - Lazy chunks (from the route-splitting refactor) are verified by
 *     observing network requests.
 *
 * What we're explicitly NOT testing here:
 *   - WebRTC / SignalR — running a real call needs two peers + a TURN
 *     server, both of which are out of scope for unit-level smoke. Those
 *     belong in a separate live-call test job that spins up the backend.
 *   - Real authentication round-trips — covered by the backend xUnit suite
 *     (AuthServiceTests).
 *
 * Run:
 *   npm run e2e           # headless, reuses dev server if already up
 *   npm run e2e -- --ui   # Playwright UI (debugger, time-travel)
 */
export default defineConfig({
  testDir: './e2e',
  // Single retry on CI catches the rare flake (animation lag) without
  // masking real bugs across multiple runs. Local: no retries — flakes
  // need to be fixed, not survived.
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  // Fail the CI build if a test accidentally adds .only()
  forbidOnly: !!process.env.CI,
  fullyParallel: true,
  use: {
    baseURL: 'http://localhost:5173',
    // Trace on failed test (first retry) — Playwright UI can replay the
    // whole DOM + network timeline. Massively cuts debug time for flakes.
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  // Vite dev server. reuseExistingServer means re-running tests during
  // development doesn't kill the dev server you have open in another
  // terminal — Playwright just attaches to it.
  webServer: {
    command: 'npm run dev',
    port: 5173,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
});
