import { SignJWT, jwtVerify } from "jose";
import type { UserRow } from "../db/users";
import { tagOf } from "../db/users";
import { fromBase64Url } from "./crypto";

/**
 * Session tokens.
 *
 * HS256, matching the .NET implementation (AuthService.cs:768 used
 * HmacSha256 with a symmetric key, despite README.md:270 claiming RS256).
 * Symmetric signing is also what makes this affordable here: HMAC over
 * WebCrypto is sub-millisecond, well inside the Workers free plan's 10ms CPU
 * ceiling.
 */

const ISSUER = "WatchTogether";
const AUDIENCE = "WatchTogether";

/**
 * 24 hours, as before. The auth cookie derives its Max-Age from this exact
 * value — see lib/cookies.ts for why that matters.
 */
export const TOKEN_TTL_SECONDS = 24 * 60 * 60;

export interface SessionClaims {
  /** User id. Named to match the .NET wire claim, so nothing downstream shifts. */
  nameid: string;
  /** Username without the discriminator. */
  unique_name: string;
  /** Full `username#1234`. Replaces the `email` claim, which no longer exists. */
  tag: string;
  /** Token id, for the revocation deny-list. */
  jti: string;
  role?: "Admin";
  /**
   * Expiry, unix seconds. Surfaced so logout can size the deny-list entry to
   * the token's own lifetime instead of guessing.
   */
  exp: number;
}

export interface IssuedToken {
  token: string;
  jti: string;
  /** Unix seconds. The cookie's lifetime is derived from this. */
  expiresAt: number;
}

function key(secret: string): Uint8Array {
  return new TextEncoder().encode(secret);
}

export async function issueToken(secret: string, user: UserRow): Promise<IssuedToken> {
  const jti = crypto.randomUUID();
  const issuedAt = Math.floor(Date.now() / 1000);
  const expiresAt = issuedAt + TOKEN_TTL_SECONDS;

  const claims = {
    nameid: user.id,
    unique_name: user.username,
    tag: tagOf(user),
    jti,
    ...(user.is_root === 1 ? { role: "Admin" as const } : {}),
  };

  const token = await new SignJWT(claims)
    .setProtectedHeader({ alg: "HS256" })
    .setIssuer(ISSUER)
    .setAudience(AUDIENCE)
    .setIssuedAt(issuedAt)
    .setExpirationTime(expiresAt)
    .sign(key(secret));

  return { token, jti, expiresAt };
}

/**
 * Reject anything not signed with HS256 before handing it to jose.
 *
 * jose enforces this too, but rejecting `alg: none` and friends up front keeps
 * the refusal explicit at the point the policy is stated, and avoids a stray
 * unhandled rejection jose raises on malformed algorithm headers.
 */
function hasAcceptedAlgorithm(token: string): boolean {
  const header = token.split(".")[0];
  if (!header) return false;

  try {
    const decoded = JSON.parse(
      new TextDecoder().decode(fromBase64Url(header)),
    ) as { alg?: unknown };
    return decoded.alg === "HS256";
  } catch {
    return false;
  }
}

/** Verify signature, issuer, audience and expiry. Returns null on any failure. */
export async function verifyToken(secret: string, token: string): Promise<SessionClaims | null> {
  if (!hasAcceptedAlgorithm(token)) return null;

  try {
    const { payload } = await jwtVerify(token, key(secret), {
      issuer: ISSUER,
      audience: AUDIENCE,
      algorithms: ["HS256"],
    });

    const claims = payload as unknown as SessionClaims;
    // A token without a jti cannot be checked against the deny-list. The .NET
    // middleware let those through (Program.cs:146 returned early on a missing
    // jti), which meant an unrevokable token. Reject instead.
    if (!claims.nameid || !claims.jti) return null;

    return claims;
  } catch {
    return null;
  }
}
