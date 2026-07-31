import { Hono } from "hono";
import type { AppEnv } from "./middleware/auth";
import { optionalAuth } from "./middleware/auth";
import { rateLimit } from "./middleware/rateLimit";
import { withSecurityHeaders } from "./middleware/securityHeaders";
import { authRoutes } from "./routes/auth";
import { passkeyRoutes } from "./routes/passkey";
import { sessionRoutes } from "./routes/session";
import { invitationRoutes } from "./routes/invitation";
import { termsRoutes } from "./routes/terms";
import { adminRoutes } from "./routes/admin";
import { sweepExpired } from "./db/revokedTokens";
import { returnExpiredTickets } from "./db/invitationLinks";

export { SessionRoom } from "./do/SessionRoom";
export { AuthChallenge } from "./do/AuthChallenge";

const app = new Hono<AppEnv>();

/**
 * Every /api/* response is JSON, never HTML. The frontend reads `.message` off
 * error bodies in ~17 places (frontend/src/services/api.ts) without guarding
 * the JSON.parse, so an HTML error page would surface as a SyntaxError that
 * masks the real status.
 */
app.onError((err, c) => {
  console.error("[worker] unhandled", err);
  return c.json({ message: "Internal server error" }, 500);
});

app.notFound((c) => c.json({ message: "Not found" }, 404));

app.use("/api/*", rateLimit("RL_GLOBAL"));
// Resolves the caller when a cookie is present without requiring one, so
// individual routes can decide. The WebSocket upgrade needs this because it
// cannot return a readable 401 body.
app.use("/api/*", optionalAuth);

app.use("/api/auth/passkey/*", rateLimit("RL_AUTH"));
app.use("/api/invitation/validate/*", rateLimit("RL_LOOKUP"));
app.use("/api/session/*", rateLimit("RL_LOOKUP"));

app.get("/api/health", (c) => c.json({ status: "healthy", timestamp: new Date().toISOString() }));

app.route("/api/auth/passkey", passkeyRoutes);
app.route("/api/auth", authRoutes);
app.route("/api/session", sessionRoutes);
app.route("/api/invitation", invitationRoutes);
app.route("/api/terms", termsRoutes);
app.route("/api/admin", adminRoutes);

export default {
  /**
   * Wrapped rather than installed as Hono middleware so that the headers are
   * applied to everything this Worker emits — including responses Hono did not
   * build, such as the onError 500 and whatever a Durable Object hands back.
   */
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    return withSecurityHeaders(await app.fetch(request, env, ctx));
  },

  /**
   * Nightly housekeeping.
   *
   * D1 has no TTL indexes, so the expiry the Mongo schema got for free is done
   * here: drop deny-list entries for tokens that have expired anyway, and
   * return invite slots held by links nobody used.
   */
  async scheduled(_event: ScheduledController, env: Env): Promise<void> {
    const revoked = await sweepExpired(env.DB);
    const tickets = await returnExpiredTickets(env.DB);
    console.log(`[cron] swept ${revoked} revoked tokens, returned ${tickets} invite tickets`);
  },
} satisfies ExportedHandler<Env>;
