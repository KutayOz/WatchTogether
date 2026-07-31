import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { buildClearedAuthCookie, readAuthCookie } from "../lib/cookies";
import { verifyToken } from "../lib/jwt";
import { revokeToken } from "../db/revokedTokens";
import { anyUserExists, tagOf } from "../db/users";
import { hasAcceptedCurrentTerms } from "../lib/terms";

export const authRoutes = new Hono<AppEnv>();

authRoutes.get("/me", requireAuth, (c) => {
  const user = c.get("user");

  return c.json({
    username: user.username,
    discriminator: user.discriminator,
    tag: tagOf(user),
    isRootUser: user.is_root === 1,
    hasAcceptedTerms: hasAcceptedCurrentTerms(user),
  });
});

/**
 * Sign out.
 *
 * Revoke first, then clear the cookie: if the response is lost in transit the
 * token is already dead, whereas clearing first would leave a live token in a
 * browser that thinks it signed out.
 */
authRoutes.post("/logout", async (c) => {
  const token = readAuthCookie(c.req.header("Cookie"));

  if (token) {
    const claims = await verifyToken(c.env.JWT_SECRET, token);
    // The deny-list entry lives exactly as long as the token would have, so
    // the nightly sweep can drop it the moment it stops mattering.
    if (claims) await revokeToken(c.env.DB, claims.jti, claims.nameid, claims.exp);
  }

  c.header("Set-Cookie", buildClearedAuthCookie());
  return c.json({ message: "Signed out." });
});

/** Drives the first-run screen. Deliberately anonymous. */
authRoutes.get("/setup/status", async (c) => {
  return c.json({ isSetupComplete: await anyUserExists(c.env.DB) });
});
