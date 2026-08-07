import type { Context } from "hono";
import type { AppEnv } from "../middleware/auth";
import { tagOf, type UserRow } from "../db/users";
import { buildAuthCookie } from "./cookies";
import { issueToken } from "./jwt";
import { hasAcceptedCurrentTerms } from "./terms";

/**
 * Issue a session and describe the signed-in user.
 *
 * The single place a session cookie is minted, so its lifetime cannot diverge
 * from the token's the way it did across two controllers in the .NET app, which
 * set a seven-day cookie around a twenty-four-hour JWT.
 *
 * It lives here rather than beside the passkey routes because there are two
 * route files that sign people in now, and a helper private to one of them
 * would have been copied into the other within the hour — which is exactly the
 * failure it exists to prevent. Every sign-in path in the app ends in this
 * function: passkey registration and authentication, first-run setup, password
 * signup and login, and reset redemption. Nothing else calls Set-Cookie.
 */
export async function loginResponse(c: Context<AppEnv>, user: UserRow) {
  const { token, expiresAt } = await issueToken(c.env.JWT_SECRET, user);
  c.header("Set-Cookie", buildAuthCookie(token, expiresAt));

  return c.json({
    username: user.username,
    discriminator: user.discriminator,
    tag: tagOf(user),
    isRootUser: user.is_root === 1,
    hasAcceptedTerms: hasAcceptedCurrentTerms(user),
  });
}
