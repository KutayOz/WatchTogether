import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-pool-workers";

// vitest-pool-workers 0.19 replaced the old `defineWorkersConfig` helper with a
// Vite plugin. Tests execute inside workerd against the real D1 and Durable
// Object implementations declared in wrangler.toml, so behaviour under test is
// the behaviour that ships.
export default defineConfig({
  plugins: [cloudflareTest({ wrangler: { configPath: "./wrangler.toml" } })],
});
