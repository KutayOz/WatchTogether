import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../migrations/0001_init.sql?raw";
import { applySchema } from "../db/testSchema";
import { createTestAuthenticator } from "../lib/testWebAuthn";
import { AUTH_COOKIE } from "../lib/cookies";
import { createInvitationLink } from "../db/invitationLinks";
import { createUser, getUserById } from "../db/users";
import { listCredentials } from "../db/credentials";

const ORIGIN = env.RP_ORIGIN;
const RP_ID = env.RP_ID;
const db = env.DB;

/**
 * Rate-limit buckets key on client IP and the limiter is live under Miniflare,
 * so each test gets its own IP. Without this, tests share one bucket and later
 * ones 429 for reasons unrelated to what they assert.
 */
let currentIp = 100;

async function post(path: string, body: unknown, cookie?: string) {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.1.0.${currentIp}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
    body: JSON.stringify(body),
  });
}

async function get(path: string, cookie?: string, method = "GET") {
  return SELF.fetch(`${ORIGIN}${path}`, {
    method,
    headers: {
      "CF-Connecting-IP": `10.1.0.${currentIp}`,
      ...(cookie ? { Cookie: cookie } : {}),
    },
  });
}

/** Pull the session cookie out of a Set-Cookie header. */
function sessionCookie(response: Response): string | null {
  const header = response.headers.get("Set-Cookie");
  if (!header) return null;
  const value = new RegExp(`${AUTH_COOKIE.replace(/[-]/g, "\\$&")}=([^;]+)`).exec(header);
  return value ? `${AUTH_COOKIE}=${value[1]}` : null;
}

beforeEach(async () => {
  currentIp++;
  await db.batch(
    ["admin_audit_log", "revoked_tokens", "invitation_links", "passkey_credentials", "users"].map(
      (table) => db.prepare(`DROP TABLE IF EXISTS ${table}`),
    ),
  );
  await applySchema(db, schema);
});

/** Create an inviter and a live invite link. */
async function seedInvite() {
  const inviter = await createUser(db, { username: "inviter", usernameLower: "inviter" });
  if (!inviter.ok) throw new Error("seed failed");

  const link = await createInvitationLink(db, inviter.user.id, 5);
  if (!link.ok) throw new Error("link failed");

  return { inviter: inviter.user, token: link.token };
}

describe("invite-scoped registration", () => {
  it("creates an account and signs the user straight in", async () => {
    const { inviter, token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "Ada",
    });
    expect(begin.status).toBe(200);
    const options = await begin.json<{ challenge: string; user: { id: string } }>();

    const finish = await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(options.challenge, ORIGIN),
      label: "Test key",
    });

    expect(finish.status).toBe(200);
    const body = await finish.json<{ username: string; tag: string; isRootUser: boolean }>();
    expect(body.username).toBe("Ada");
    expect(body.tag).toMatch(/^Ada#\d{4}$/);
    expect(body.isRootUser).toBe(false);

    // Registration logs you in — there is no verification step to wait for.
    expect(sessionCookie(finish)).toBeTruthy();

    const users = await db
      .prepare("SELECT * FROM users WHERE username_lower = 'ada'")
      .first<{ id: string; user_handle: string; invited_by_user_id: string }>();
    expect(users?.invited_by_user_id).toBe(inviter.id);

    // The handle in the database must be the one the authenticator was given
    // at /begin. The .NET code generated it twice and stored the second.
    expect(options.user.id).toBe(users!.user_handle);

    const credentials = await listCredentials(db, users!.id);
    expect(credentials).toHaveLength(1);
    expect(credentials[0]!.label).toBe("Test key");
    expect(credentials[0]!.transports).toBe(JSON.stringify(["internal"]));
  });

  it("burns the invite so it cannot be used twice", async () => {
    const { token } = await seedInvite();

    const first = await createTestAuthenticator(RP_ID);
    const beginA = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "first",
    });
    await post("/api/auth/passkey/register/finish", {
      response: await first.register((await beginA.json<{ challenge: string }>()).challenge, ORIGIN),
    });

    const second = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "second",
    });
    expect(second.status).toBe(400);
    expect(await second.json()).toMatchObject({ message: expect.stringContaining("not valid") });
  });

  it("refuses a challenge that has already been consumed", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "replay",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    const response = await authenticator.register(challenge, ORIGIN);

    expect((await post("/api/auth/passkey/register/finish", { response })).status).toBe(200);
    // Replaying the identical response must fail: the challenge is single-use.
    expect((await post("/api/auth/passkey/register/finish", { response })).status).toBe(400);
  });

  it("rejects a ceremony completed against a different origin", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "phished",
    });
    const { challenge } = await begin.json<{ challenge: string }>();

    const finish = await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, "https://evil.example.com"),
    });

    expect(finish.status).toBe(400);
  });

  it("creates nothing when verification fails", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "ghost",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, "https://evil.example.com"),
    });

    const ghost = await db
      .prepare("SELECT 1 AS n FROM users WHERE username_lower = 'ghost'")
      .first();
    expect(ghost).toBeNull();

    // And the invite must still be usable, not spent on a failed attempt.
    const retry = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "ghost",
    });
    expect(retry.status).toBe(200);
  });
});

describe("usernameless sign-in", () => {
  async function registerUser(username: string) {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username,
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    const finish = await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, ORIGIN),
    });

    const user = await db
      .prepare("SELECT * FROM users WHERE username_lower = ?")
      .bind(username.toLowerCase())
      .first<{ id: string; user_handle: string }>();

    return { authenticator, user: user!, cookie: sessionCookie(finish)! };
  }

  it("signs in with no username supplied", async () => {
    const { authenticator, user } = await registerUser("Kutay");

    // No identifier is sent — the discoverable credential carries the identity.
    const begin = await post("/api/auth/passkey/auth/begin", {});
    const { challenge } = await begin.json<{ challenge: string }>();

    const finish = await post(
      "/api/auth/passkey/auth/finish",
      await authenticator.authenticate(challenge, ORIGIN, user.user_handle),
    );

    expect(finish.status).toBe(200);
    expect(await finish.json()).toMatchObject({ username: "Kutay" });
    expect(sessionCookie(finish)).toBeTruthy();
  });

  it("advances the signature counter", async () => {
    const { authenticator, user } = await registerUser("counter");

    const begin = await post("/api/auth/passkey/auth/begin", {});
    const { challenge } = await begin.json<{ challenge: string }>();
    await post(
      "/api/auth/passkey/auth/finish",
      await authenticator.authenticate(challenge, ORIGIN, user.user_handle, 7),
    );

    const credential = (await listCredentials(db, user.id))[0]!;
    expect(credential.counter).toBe(7);
    expect(credential.last_used_at).not.toBeNull();
  });

  it("rejects an assertion carrying someone else's user handle", async () => {
    const { authenticator } = await registerUser("victim");

    const begin = await post("/api/auth/passkey/auth/begin", {});
    const { challenge } = await begin.json<{ challenge: string }>();

    const finish = await post(
      "/api/auth/passkey/auth/finish",
      await authenticator.authenticate(challenge, ORIGIN, "some-other-handle"),
    );

    expect(finish.status).toBe(401);
  });

  it("rejects an unknown credential", async () => {
    const stranger = await createTestAuthenticator(RP_ID);
    const begin = await post("/api/auth/passkey/auth/begin", {});
    const { challenge } = await begin.json<{ challenge: string }>();

    const finish = await post(
      "/api/auth/passkey/auth/finish",
      await stranger.authenticate(challenge, ORIGIN, "handle"),
    );

    expect(finish.status).toBe(401);
  });

  it("issues a session that /me accepts and logout kills", async () => {
    const { cookie } = await registerUser("session");

    const me = await get("/api/auth/me", cookie);
    expect(me.status).toBe(200);
    expect(await me.json()).toMatchObject({ username: "session" });

    expect((await post("/api/auth/logout", {}, cookie)).status).toBe(200);

    // Revocation is checked on every request, so the cookie dies immediately
    // rather than lingering until the token would have expired.
    const after = await get("/api/auth/me", cookie);
    expect(after.status).toBe(401);
  });
});

describe("root bootstrap", () => {
  it("refuses without the setup secret", async () => {
    const response = await post("/api/auth/passkey/setup/begin", { username: "kutay" });
    expect(response.status).toBe(403);
  });

  it("creates the root account at #0000 and refuses a second", async () => {
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/setup/begin", {
      username: "kutay",
      setupSecret: env.SETUP_SECRET,
    });
    expect(begin.status).toBe(200);

    const finish = await post("/api/auth/passkey/setup/finish", {
      response: await authenticator.register(
        (await begin.json<{ challenge: string }>()).challenge,
        ORIGIN,
      ),
    });

    expect(finish.status).toBe(200);
    expect(await finish.json()).toMatchObject({ isRootUser: true, tag: "kutay#0000" });

    // Setup is once, ever.
    const second = await post("/api/auth/passkey/setup/begin", {
      username: "usurper",
      setupSecret: env.SETUP_SECRET,
    });
    const secondAuth = await createTestAuthenticator(RP_ID);
    const secondFinish = await post("/api/auth/passkey/setup/finish", {
      response: await secondAuth.register(
        (await second.json<{ challenge: string }>()).challenge,
        ORIGIN,
      ),
    });
    expect(secondFinish.status).toBe(403);
  });
});

describe("credential management", () => {
  it("refuses to delete the only passkey", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "solo",
    });
    const finish = await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(
        (await begin.json<{ challenge: string }>()).challenge,
        ORIGIN,
      ),
    });
    const cookie = sessionCookie(finish)!;

    const listed = await get("/api/auth/passkey", cookie);
    const { items } = await listed.json<{ items: { credentialId: string }[] }>();
    expect(items).toHaveLength(1);

    const deleted = await get(
      `/api/auth/passkey/${encodeURIComponent(items[0]!.credentialId)}`,
      cookie,
      "DELETE",
    );

    // Passwords are gone, so the last passkey is the only way back in.
    expect(deleted.status).toBe(400);
  });
});

describe("CPU budget", () => {
  it("verifies a registration well inside the 10ms free-plan ceiling", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);

    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "budget",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    const response = await authenticator.register(challenge, ORIGIN);

    const { verifyRegistrationResponse } = await import("@simplewebauthn/server");
    const started = Date.now();
    const result = await verifyRegistrationResponse({
      response: response as never,
      expectedChallenge: challenge,
      expectedOrigin: ORIGIN,
      expectedRPID: RP_ID,
    });
    const elapsed = Date.now() - started;

    expect(result.verified).toBe(true);
    // Wall clock over-reports CPU (WebCrypto is async and does not bill against
    // the CPU budget), so passing here is necessary but not sufficient — the
    // authoritative number comes from production telemetry.
    console.log(`verifyRegistrationResponse wall clock: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(50);
  });
});
