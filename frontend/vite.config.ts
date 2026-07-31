// defineConfig comes from 'vitest/config' rather than 'vite' so the `test`
// block below is typed. It's a superset of vite's — every non-test option
// behaves identically, and vitest is a devDependency that `npm ci` installs,
// so the Docker build stage still resolves it.
import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  test: {
    /*
     * Unit tests. Separate from e2e/ — those are Playwright specs against a
     * running app (`npm run e2e`) and must NOT be picked up here, hence the
     * explicit include rather than vitest's default glob.
     *
     * environment: 'node' — not jsdom. The only thing under test today is
     * services/api.ts, a fetch wrapper with no DOM dependency; the handful of
     * browser globals it touches on the 401 path (window.location, localStorage,
     * sessionStorage) are stubbed per-test with vi.stubGlobal. That's both
     * lighter than pulling in jsdom and *more* precise here: jsdom refuses to
     * perform navigation, so it can't observe the login redirect we assert on.
     * Adding component tests later means installing jsdom and switching this.
     */
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
  build: {
    /*
     * Bundle splitting strategy
     *
     * The default (one big chunk) was producing a 556 kB main bundle that
     * every visitor downloaded before /login could render. We split along
     * two axes:
     *
     *   1) Vendor chunks (long-lived, deploy-cached) — React, SignalR,
     *      and webrtc-adapter rarely change between releases, so isolating
     *      them means the user's browser keeps the cached file across
     *      most of our deploys. signalr + webrtc-adapter are also gated
     *      to the session route — auth/lobby visitors don't pay for them.
     *
     *   2) Route group chunks — each top-level area (auth, lobby, session,
     *      admin, settings) compiles into its own chunk. Lazy() in App.tsx
     *      makes the import dynamic; this config decides how Rollup groups
     *      the files. Bigger-than-one-file groups (auth = 5 screens) keep
     *      chunk count sensible while still buying back the win.
     *
     * Caveats:
     *   - Anything matched here MUST NOT be imported synchronously from a
     *     file outside its own group, or Vite will silently inline it back
     *     into the importer's chunk. Keep eager imports for vendor + route
     *     groups under control by routing through lazy() in App.tsx.
     *   - Order matters: more specific patterns must come first (route
     *     groups before vendor; otherwise a node_modules check would catch
     *     a re-export and we'd lose granularity).
     */
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Route groups — keyed off the on-disk path. Group multiple
          // related screens into one chunk so the network round-trip count
          // stays low. Vite + Rollup will only emit these chunks if at
          // least one entry references them transitively.
          if (id.includes('/components/Auth/') || id.includes('/components/Login/')) {
            return 'auth';
          }
          if (id.includes('/components/Session/')) {
            return 'session';
          }
          if (id.includes('/components/Admin/')) {
            return 'admin';
          }
          if (id.includes('/components/Settings/')) {
            return 'settings';
          }
          if (id.includes('/components/Lobby/')) {
            return 'lobby';
          }

          // Vendor chunks — only for the heavy / stable deps. Everything
          // else (small libs, our own utils) falls back to default chunking.
          if (id.includes('node_modules')) {
            if (
              id.includes('node_modules/react/') ||
              id.includes('node_modules/react-dom/') ||
              id.includes('node_modules/react-router') ||
              id.includes('node_modules/scheduler/') // peer dep of react
            ) {
              return 'react-vendor';
            }
            if (id.includes('node_modules/@microsoft/signalr')) {
              return 'signalr';
            }
            if (id.includes('node_modules/webrtc-adapter')) {
              return 'webrtc-adapter';
            }
            // Mediapipe is already dynamic-imported from useBackgroundBlur
            // and emits its own chunk via the runtime import. Don't override.
            // Zxcvbn dictionaries are dynamic-imported from zxcvbnLoader.ts
            // and already emit their own chunks. Don't override.
          }
        },
      },
    },
    // Now that we've consciously sized each chunk, push the warning ceiling
    // up so CI doesn't flag legitimate large chunks (the zxcvbn dictionaries
    // are 1.2 MB on their own, but they're lazy + only hit on /register).
    chunkSizeWarningLimit: 700,
  },
})
