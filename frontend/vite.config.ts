import { fileURLToPath, URL } from 'node:url'
// defineConfig comes from 'vitest/config' rather than 'vite' so the `test`
// block below is typed. It's a superset of vite's — every non-test option
// behaves identically, and vitest is a devDependency that `npm ci` installs.
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
     * environment: happy-dom, not node and not jsdom. wsService builds its URL
     * from window.location and compares against WebSocket's static readyState
     * constants, so a real DOM is needed; the socket itself is a fake, so
     * nothing dials out. jsdom is the wrong DOM here specifically because it
     * refuses to perform navigation, which would hide the 401 login redirect
     * api.test.ts asserts on.
     */
    environment: 'happy-dom',
    include: ['src/**/*.test.ts'],
  },
  resolve: {
    alias: {
      /*
       * The wire protocol is one contract, and it used to be two hand-mirrored
       * copies in two languages — a change on one side failed at runtime on the
       * other, silently. Importing the Worker's own module means drift is a
       * compile error instead.
       */
      '@shared': fileURLToPath(new URL('../worker/src/lib', import.meta.url)),
    },
  },
  server: {
    // The alias resolves outside the Vite root, so the dev server has to be
    // allowed to serve from the repo root.
    fs: { allow: ['..'] },
    /*
     * Single-origin in production: the Worker serves both the SPA and /api/*.
     * `vite dev` runs on its own port, so proxy the API — including the
     * WebSocket upgrade — at `wrangler dev`. Without ws:true the upgrade would
     * 404 and the session would never join.
     */
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8787',
        changeOrigin: true,
        ws: true,
      },
    },
  },
  build: {
    /*
     * Bundle splitting strategy
     *
     * The default (one big chunk) was producing a 556 kB main bundle that
     * every visitor downloaded before /login could render. We split along
     * two axes:
     *
     *   1) Vendor chunks (long-lived, deploy-cached) — React and
     *      webrtc-adapter rarely change between releases, so isolating
     *      them means the user's browser keeps the cached file across
     *      most of our deploys. webrtc-adapter is also gated to the
     *      session route — auth/lobby visitors don't pay for it.
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
