import type { Context, MiddlewareHandler, Next } from "hono";
import { readAuthCookie } from "../lib/cookies";
import { verifyToken, type SessionClaims } from "../lib/jwt";
import { isTokenRevoked } from "../db/revokedTokens";
import { getUserById, type UserRow } from "../db/users";

export interface AuthVariables {
  claims: SessionClaims;
  user: UserRow;
}

export type AppEnv = { Bindings: Env; Variables: AuthVariables };

/**
 * Resolve the caller from the session cookie.
 *
 * Cookie only — the .NET version additionally accepted `?access_token=` in the
 * query string for the SignalR handshake (Program.cs:163), which put a bearer
 * token everywhere URLs get logged. The WebSocket upgrade here carries the
 * cookie like every other same-origin request, so that path is not needed.
 */
async function resolve(c: Context<AppEnv>): Promise<UserRow | null> {
  const token = readAuthCookie(c.req.header("Cookie"));
  if (!token) return null;

  const claims = await verifyToken(c.env.JWT_SECRET, token);
  if (!claims) return null;

  // Checked on every request: logout must take effect immediately, not
  // whenever the token happens to expire.
  if (await isTokenRevoked(c.env.DB, claims.jti)) return null;

  const user = await getUserById(c.env.DB, claims.nameid);
  if (!user) return null;

  c.set("claims", claims);
  c.set("user", user);
  return user;
}

/** 401s anonymous callers. */
export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next: Next) => {
  const user = await resolve(c);
  if (!user) return c.json({ message: "Unauthorized" }, 401);
  return next();
};

/**
 * 403s non-root callers.
 *
 * Authority comes from the freshly-read `is_root` column, not from the JWT's
 * `role` claim, so demoting someone takes effect on their next request rather
 * than whenever their 24-hour token expires.
 */
export const requireRoot: MiddlewareHandler<AppEnv> = async (c, next: Next) => {
  const user = await resolve(c);
  if (!user) return c.json({ message: "Unauthorized" }, 401);
  if (user.is_root !== 1) return c.json({ message: "Forbidden" }, 403);
  return next();
};

/** Populates the caller when present, without requiring one. */
export const optionalAuth: MiddlewareHandler<AppEnv> = async (c, next: Next) => {
  await resolve(c);
  return next();
};

/** For non-Hono call sites such as the WebSocket upgrade. */
export async function authenticateRequest(
  env: Env,
  request: Request,
): Promise<UserRow | null> {
  const token = readAuthCookie(request.headers.get("Cookie"));
  if (!token) return null;

  const claims = await verifyToken(env.JWT_SECRET, token);
  if (!claims) return null;
  if (await isTokenRevoked(env.DB, claims.jti)) return null;

  return getUserById(env.DB, claims.nameid);
}
