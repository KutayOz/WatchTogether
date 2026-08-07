import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../db/testSchema";
import { AUTH_COOKIE } from "../lib/cookies";
import { issueToken } from "../lib/jwt";
import { TERMS_VERSION } from "../lib/terms";
import { createUser, type UserRow } from "../db/users";

/**
 * The routes in auth.ts, exercised end to end against real D1 rows.
 *
 * These endpoints answer three questions about a caller — who are you, are you
 * square with the terms, and are you still signed in — and every answer is read
 * from the row at request time rather than from the token. That seam is what is
 * pinned here. lib/terms.test.ts already covers the predicate in isolation, but
 * it hand-builds the user object, and the Playwright specs mock /me's answer
 * outright: between those two there was no test that a stale `terms_version`
 * sitting in the database actually reaches the caller as a re-prompt.
 */

const ORIGIN = env.RP_ORIGIN;
const db = env.DB;

/** Rate-limit buckets key on client IP and the limiter is live under Miniflare. */
let currentIp = 200;

const request = (path: string, init: RequestInit = {}, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.2.0.${currentIp}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

beforeEach(async () => {
  currentIp++;
  await resetDatabase(db);
});

interface SignedIn {
  user: UserRow;
  cookie: string;
  jti: string;
  expiresAt: number;
}

/**
 * A real row and a real session token for it.
 *
 * Deliberately skips the passkey ceremony — passkey.test.ts owns that — and
 * mints the token with the same `issueToken` the login routes call, so the
 * cookie under test is the cookie that ships.
 */
async function signedIn(username: string): Promise<SignedIn> {
  const created = await createUser(db, { username, usernameLower: username.toLowerCase() });
  if (!created.ok) throw new Error(`seed failed: ${created.error}`);

  const { token, jti, expiresAt } = await issueToken(env.JWT_SECRET, created.user);
  return { user: created.user, cookie: `${AUTH_COOKIE}=${token}`, jti, expiresAt };
}

/** Write an acceptance directly, the way an older release would have left one. */
async function recordAcceptance(userId: string, version: string | null): Promise<void> {
  await db
    .prepare("UPDATE users SET accepted_terms_at = ?, terms_version = ? WHERE id = ?")
    .bind(Date.now(), version, userId)
    .run();
}

const me = async (cookie?: string) => request("/api/auth/me", {}, cookie);

describe("GET /api/auth/me", () => {
  it("401s an anonymous caller", async () => {
    expect((await me()).status).toBe(401);
  });

  it("/me reads the accepted version, not just the timestamp", async () => {
    const { user, cookie } = await signedIn("stale");

    // A row exactly as a user who accepted v0.9 and never came back leaves it:
    // timestamp present, version behind. The check /me used to make was
    // `accepted_terms_at !== null`, which reports this row as accepted and
    // makes every future TERMS_VERSION bump a no-op for them.
    await recordAcceptance(user.id, "0.9");

    const response = await me(cookie);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      tag: user.username + "#" + user.discriminator,
      hasAcceptedTerms: false,
    });

    // Same row, same cookie, same request — only the stored version changes.
    await recordAcceptance(user.id, TERMS_VERSION);
    expect(await (await me(cookie)).json()).toMatchObject({ hasAcceptedTerms: true });
  });

  it("re-prompts a row whose timestamp predates the version column", async () => {
    const { user, cookie } = await signedIn("legacy");
    await recordAcceptance(user.id, null);

    expect(await (await me(cookie)).json()).toMatchObject({ hasAcceptedTerms: false });
  });

  it("re-prompts a user who has never accepted anything", async () => {
    const { user, cookie } = await signedIn("fresh");

    const row = await db
      .prepare("SELECT accepted_terms_at, terms_version FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ accepted_terms_at: number | null; terms_version: string | null }>();
    expect(row).toMatchObject({ accepted_terms_at: null, terms_version: null });

    expect(await (await me(cookie)).json()).toMatchObject({ hasAcceptedTerms: false });
  });

  it("clears the re-prompt only once acceptance writes the version in force", async () => {
    const { user, cookie } = await signedIn("accepting");

    expect((await request("/api/terms/accept", { method: "POST" }, cookie)).status).toBe(200);

    // The write side of the same seam: /api/terms/accept must store the version
    // /me compares against. Storing anything else — or only the timestamp —
    // leaves the user gated forever, with no control that can clear it.
    const row = await db
      .prepare("SELECT accepted_terms_at, terms_version FROM users WHERE id = ?")
      .bind(user.id)
      .first<{ accepted_terms_at: number | null; terms_version: string | null }>();
    expect(row!.terms_version).toBe(TERMS_VERSION);
    expect(row!.accepted_terms_at).not.toBeNull();

    expect(await (await me(cookie)).json()).toMatchObject({ hasAcceptedTerms: true });
  });

  it("reports root from the row, not the role claim in the token", async () => {
    const { user, cookie } = await signedIn("promoted");
    expect(await (await me(cookie)).json()).toMatchObject({ isRootUser: false });

    // The token was signed before the promotion and carries no `role` claim.
    // Reading `is_root` fresh is what makes a promotion — or a demotion — take
    // effect on the next request instead of whenever the 24-hour token lapses.
    await db.prepare("UPDATE users SET is_root = 1 WHERE id = ?").bind(user.id).run();

    expect(await (await me(cookie)).json()).toMatchObject({ isRootUser: true });
  });

  it("401s once the row is soft-deleted", async () => {
    const { user, cookie } = await signedIn("doomed");
    expect((await me(cookie)).status).toBe(200);

    await db.prepare("UPDATE users SET is_deleted = 1 WHERE id = ?").bind(user.id).run();

    // getUserById filters on is_deleted, so an admin deletion ends the session
    // on the next request rather than leaving a live token behind it.
    expect((await me(cookie)).status).toBe(401);
  });
});

describe("POST /api/auth/logout", () => {
  it("revokes the token and clears the cookie", async () => {
    const { user, cookie, jti, expiresAt } = await signedIn("leaving");

    const response = await request("/api/auth/logout", { method: "POST" }, cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");

    const revoked = await db
      .prepare("SELECT * FROM revoked_tokens WHERE jti = ?")
      .bind(jti)
      .first<{ user_id: string; expires_at: number }>();
    // Sized to the token's own expiry, so the nightly sweep can drop the entry
    // the moment the token it denies would have expired anyway.
    expect(revoked).toMatchObject({ user_id: user.id, expires_at: expiresAt * 1000 });

    expect((await me(cookie)).status).toBe(401);
  });

  it("succeeds without a cookie", async () => {
    // The terms gate's decline button signs you out. If a lapsed or already
    // cleared session made that call fail, declining would leave the user
    // stranded in the gate — the exact dead end #14 exists to prevent.
    const response = await request("/api/auth/logout", { method: "POST" });

    expect(response.status).toBe(200);
    expect(response.headers.get("Set-Cookie")).toContain("Max-Age=0");
  });

  it("is idempotent", async () => {
    const { cookie } = await signedIn("twice");

    expect((await request("/api/auth/logout", { method: "POST" }, cookie)).status).toBe(200);
    // ON CONFLICT DO NOTHING on the deny-list insert — a double sign-out, or a
    // retried request, must not 500.
    expect((await request("/api/auth/logout", { method: "POST" }, cookie)).status).toBe(200);
  });
});

describe("GET /api/auth/setup/status", () => {
  it("flips once the first account exists, and answers anonymously", async () => {
    const before = await request("/api/auth/setup/status");
    expect(before.status).toBe(200);
    expect(await before.json()).toMatchObject({ isSetupComplete: false });

    await signedIn("first");

    expect(await (await request("/api/auth/setup/status")).json()).toMatchObject({
      isSetupComplete: true,
    });
  });
});
