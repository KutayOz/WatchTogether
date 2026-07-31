/**
 * The session cookie.
 *
 * `__Host-` prefix: browsers only accept it when the cookie is Secure, has
 * Path=/, and carries no Domain — which pins it to this exact host and makes
 * it unsettable by any subdomain. Free hardening, and with no existing users
 * there was no migration cost to adopting it.
 */
export const AUTH_COOKIE = "__Host-wt_auth";

/**
 * Build the Set-Cookie header.
 *
 * Max-Age is derived from the token's own `exp` rather than passed
 * independently. The .NET code set these in two places with two different
 * lifetimes — password login used 24h, passkey login used 7 days
 * (PasskeyController.cs:170) — while the JWT itself always expired in 24h. The
 * result was three days of a cookie being sent that every request rejected.
 * Deriving one from the other makes that class of drift impossible.
 */
export function buildAuthCookie(token: string, expiresAtUnixSeconds: number): string {
  const maxAge = Math.max(0, expiresAtUnixSeconds - Math.floor(Date.now() / 1000));

  return [
    `${AUTH_COOKIE}=${token}`,
    "Path=/",
    "HttpOnly",
    "Secure",
    // Strict is safe here because no state-changing request is a GET, and the
    // SPA's own fetches are same-origin. The visible cost is that following an
    // invite link from another site paints logged-out for one frame until the
    // app's first same-site request runs.
    "SameSite=Strict",
    `Max-Age=${maxAge}`,
  ].join("; ");
}

/** Expire the cookie. Attributes must match the original or browsers ignore it. */
export function buildClearedAuthCookie(): string {
  return [`${AUTH_COOKIE}=`, "Path=/", "HttpOnly", "Secure", "SameSite=Strict", "Max-Age=0"].join(
    "; ",
  );
}

/** Read the session token out of a Cookie header. */
export function readAuthCookie(header: string | null | undefined): string | null {
  if (!header) return null;

  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator === -1) continue;
    if (part.slice(0, separator).trim() !== AUTH_COOKIE) continue;
    return part.slice(separator + 1).trim() || null;
  }
  return null;
}
