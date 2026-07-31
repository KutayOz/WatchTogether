import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { SignJWT } from "jose";
import { AUTH_COOKIE, buildAuthCookie, buildClearedAuthCookie, readAuthCookie } from "./cookies";
import { TOKEN_TTL_SECONDS, issueToken, verifyToken } from "./jwt";
import type { UserRow } from "../db/users";
import type { StoredChallenge } from "../do/AuthChallenge";

const SECRET = "test-secret-at-least-32-bytes-long-for-hs256";

const user: UserRow = {
  id: "user-1",
  username: "Kutay",
  username_lower: "kutay",
  discriminator: "0042",
  user_handle: "handle",
  is_root: 0,
  active_link_count: 0,
  invited_by_user_id: null,
  accepted_terms_at: null,
  terms_version: null,
  created_at: Date.now(),
  is_deleted: 0,
  deleted_at: null,
  deleted_by_user_id: null,
};

describe("jwt", () => {
  it("round-trips claims", async () => {
    const { token } = await issueToken(SECRET, user);
    const claims = await verifyToken(SECRET, token);

    expect(claims).toMatchObject({
      nameid: "user-1",
      unique_name: "Kutay",
      tag: "Kutay#0042",
    });
    // No email claim survives — it is not part of the identity any more.
    expect(claims).not.toHaveProperty("email");
  });

  it("marks root users with the Admin role and nobody else", async () => {
    const root = await verifyToken(SECRET, (await issueToken(SECRET, { ...user, is_root: 1 })).token);
    const plain = await verifyToken(SECRET, (await issueToken(SECRET, user)).token);

    expect(root?.role).toBe("Admin");
    expect(plain?.role).toBeUndefined();
  });

  it("gives every token a distinct jti so revocation is per-session", async () => {
    const a = await issueToken(SECRET, user);
    const b = await issueToken(SECRET, user);
    expect(a.jti).not.toBe(b.jti);
  });

  it("rejects a token signed with a different secret", async () => {
    const { token } = await issueToken("some-other-secret-at-least-32-bytes-long", user);
    expect(await verifyToken(SECRET, token)).toBeNull();
  });

  it("rejects a tampered payload", async () => {
    const { token } = await issueToken(SECRET, user);
    const [header, , signature] = token.split(".");
    const forged = btoa(JSON.stringify({ nameid: "someone-else", jti: "x" }))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    expect(await verifyToken(SECRET, `${header}.${forged}.${signature}`)).toBeNull();
  });

  it("rejects an expired token", async () => {
    const expired = await new SignJWT({ nameid: "user-1", jti: "j1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("WatchTogether")
      .setAudience("WatchTogether")
      .setExpirationTime(Math.floor(Date.now() / 1000) - 60)
      .sign(new TextEncoder().encode(SECRET));

    expect(await verifyToken(SECRET, expired)).toBeNull();
  });

  it("rejects a token with no jti, which could never be revoked", async () => {
    const unrevokable = await new SignJWT({ nameid: "user-1" })
      .setProtectedHeader({ alg: "HS256" })
      .setIssuer("WatchTogether")
      .setAudience("WatchTogether")
      .setExpirationTime(Math.floor(Date.now() / 1000) + 600)
      .sign(new TextEncoder().encode(SECRET));

    // The .NET middleware let these through, leaving a token logout could not kill.
    expect(await verifyToken(SECRET, unrevokable)).toBeNull();
  });

  it("rejects an alg:none token", async () => {
    const header = btoa(JSON.stringify({ alg: "none", typ: "JWT" })).replace(/=+$/, "");
    const payload = btoa(JSON.stringify({ nameid: "user-1", jti: "j" })).replace(/=+$/, "");
    expect(await verifyToken(SECRET, `${header}.${payload}.`)).toBeNull();
  });
});

describe("auth cookie", () => {
  it("derives Max-Age from the token's own expiry", async () => {
    const { token, expiresAt } = await issueToken(SECRET, user);
    const cookie = buildAuthCookie(token, expiresAt);

    const maxAge = Number(/Max-Age=(\d+)/.exec(cookie)![1]);
    // The .NET passkey path set a 7-day cookie around a 24-hour JWT, so for six
    // days the browser sent a token every request rejected.
    expect(Math.abs(maxAge - TOKEN_TTL_SECONDS)).toBeLessThanOrEqual(1);
  });

  it("carries the attributes the __Host- prefix requires", () => {
    const cookie = buildAuthCookie("token", Math.floor(Date.now() / 1000) + 60);

    expect(cookie).toContain(`${AUTH_COOKIE}=`);
    expect(AUTH_COOKIE.startsWith("__Host-")).toBe(true);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("Secure");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Strict");
    // A Domain attribute would make the browser reject a __Host- cookie outright.
    expect(cookie).not.toContain("Domain=");
  });

  it("never returns a negative Max-Age for an already-expired token", () => {
    const cookie = buildAuthCookie("token", Math.floor(Date.now() / 1000) - 5000);
    expect(cookie).toContain("Max-Age=0");
  });

  it("clears with matching attributes", () => {
    const cleared = buildClearedAuthCookie();
    expect(cleared).toContain("Max-Age=0");
    expect(cleared).toContain("Path=/");
    expect(cleared).toContain("Secure");
  });

  it("reads its own cookie out of a crowded header", () => {
    const header = `theme=dark; ${AUTH_COOKIE}=abc.def.ghi; other=1`;
    expect(readAuthCookie(header)).toBe("abc.def.ghi");
  });

  it.each([
    ["", null],
    ["theme=dark", null],
    [`${AUTH_COOKIE}=`, null],
  ])("returns null for %s", (header, expected) => {
    expect(readAuthCookie(header)).toBe(expected);
  });

  it("is not confused by a lookalike cookie name", () => {
    // A cookie without the __Host- prefix can be set by a subdomain; it must
    // never be mistaken for the real one.
    expect(readAuthCookie("wt_auth=attacker-token")).toBeNull();
  });
});

describe("AuthChallenge durable object", () => {
  const stubFor = (name: string) => env.CHALLENGE.get(env.CHALLENGE.idFromName(name));

  const put = (challenge: string, overrides: Partial<StoredChallenge> = {}) =>
    stubFor(challenge).fetch("https://do/put", {
      method: "POST",
      body: JSON.stringify({
        kind: "auth",
        challenge,
        expiresAt: Date.now() + 120_000,
        ...overrides,
      } satisfies StoredChallenge),
    });

  const consume = (challenge: string) =>
    stubFor(challenge)
      .fetch("https://do/consume", { method: "POST" })
      .then((r) => r.json<{ ok: boolean; error?: string; challenge?: StoredChallenge }>());

  it("stores and returns a challenge", async () => {
    await put("challenge-a", { userId: "u1", username: "alice" });
    const result = await consume("challenge-a");

    expect(result.ok).toBe(true);
    expect(result.challenge).toMatchObject({ userId: "u1", username: "alice" });
  });

  it("consumes exactly once, so an assertion cannot be replayed", async () => {
    await put("challenge-b");

    expect((await consume("challenge-b")).ok).toBe(true);
    // Read and delete happen in one invocation, so there is no window for a
    // second consumer to slip between them.
    expect(await consume("challenge-b")).toMatchObject({ ok: false, error: "not_found" });
  });

  it("admits only one winner when consumed concurrently", async () => {
    await put("challenge-c");
    const results = await Promise.all([
      consume("challenge-c"),
      consume("challenge-c"),
      consume("challenge-c"),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
  });

  it("refuses an expired challenge", async () => {
    await put("challenge-d", { expiresAt: Date.now() - 1 });
    expect(await consume("challenge-d")).toMatchObject({ ok: false, error: "expired" });
  });

  it("reports an unknown challenge as missing", async () => {
    expect(await consume("never-stored")).toMatchObject({ ok: false, error: "not_found" });
  });
});
