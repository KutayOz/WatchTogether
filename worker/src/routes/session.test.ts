import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../db/testSchema";
import { TERMS_VERSION } from "../lib/terms";
import { createTestAuthenticator } from "../lib/testWebAuthn";
import { AUTH_COOKIE } from "../lib/cookies";
import { buildInviteToken, parseInviteToken } from "../lib/sessionId";
import { createInvitationLink } from "../db/invitationLinks";
import { createUser } from "../db/users";

const ORIGIN = env.RP_ORIGIN;
const RP_ID = env.RP_ID;
const db = env.DB;

/**
 * Rate-limit buckets are keyed on client IP, and the limiter is genuinely
 * active under Miniflare. Giving each test its own IP isolates the buckets
 * without weakening the production limits — and matches reality, where these
 * requests would come from different people.
 */
let currentIp = 0;

const request = (path: string, init: RequestInit = {}, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.0.0.${currentIp}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

const post = (path: string, body: unknown, cookie?: string) =>
  request(path, { method: "POST", body: JSON.stringify(body) }, cookie);

function sessionCookie(response: Response): string | null {
  const header = response.headers.get("Set-Cookie");
  if (!header) return null;
  const match = new RegExp(`${AUTH_COOKIE.replace(/[-]/g, "\\$&")}=([^;]+)`).exec(header);
  return match ? `${AUTH_COOKIE}=${match[1]}` : null;
}

beforeEach(async () => {
  currentIp++;
  await resetDatabase(db);
});

/** Register a user through the real ceremony and return their session cookie. */
async function signedInUser(username: string): Promise<string> {
  const inviter = await createUser(db, { username: `inv-${username}`, usernameLower: `inv-${username}` });
  if (!inviter.ok) throw new Error("seed failed");
  const link = await createInvitationLink(db, inviter.user.id, 5);
  if (!link.ok) throw new Error("link failed");

  const authenticator = await createTestAuthenticator(RP_ID);
  const begin = await post("/api/auth/passkey/register/begin", {
    inviteToken: link.token,
    username,
  });
  const finish = await post("/api/auth/passkey/register/finish", {
    response: await authenticator.register((await begin.json<{ challenge: string }>()).challenge, ORIGIN),
  });

  const cookie = sessionCookie(finish);
  if (!cookie) throw new Error(`sign-in failed: ${finish.status} ${await finish.text()}`);
  return cookie;
}

describe("sessions", () => {
  it("requires authentication to create one", async () => {
    expect((await post("/api/session/create", {})).status).toBe(401);
  });

  it("creates a session the creator can then validate", async () => {
    const cookie = await signedInUser("creator");

    const created = await post("/api/session/create", {}, cookie);
    expect(created.status).toBe(200);
    const { sessionId } = await created.json<{ sessionId: string }>();
    // 12 random bytes, base64url — 96 bits, as in SessionService.cs.
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{16}$/);

    const validated = await request(`/api/session/${sessionId}/validate`, {}, cookie);
    expect(await validated.json()).toMatchObject({
      exists: true,
      valid: true,
      participantCount: 0,
    });
  });

  it("reports an unknown session as non-existent rather than erroring", async () => {
    const cookie = await signedInUser("looker");
    const response = await request("/api/session/doesnotexist00/validate", {}, cookie);

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ exists: false, valid: false });
  });

  it("serves ICE servers, falling back to STUN with no TURN configured", async () => {
    const cookie = await signedInUser("ice");
    const response = await request("/api/session/ice-servers", {}, cookie);

    const { iceServers } = await response.json<{ iceServers: { urls: string }[] }>();
    expect(iceServers.length).toBeGreaterThanOrEqual(2);
    // Degrades rather than failing the call outright.
    expect(iceServers.every((server) => typeof server.urls === "string")).toBe(true);
    expect(iceServers[0]!.urls).toContain("stun:");
  });
});

describe("session invites", () => {
  it("lets the creator mint an invite another user can redeem once", async () => {
    const creator = await signedInUser("owner");
    const guest = await signedInUser("guest");

    const { sessionId } = await (await post("/api/session/create", {}, creator)).json<{
      sessionId: string;
    }>();

    const minted = await post(`/api/session/${sessionId}/invite`, {}, creator);
    expect(minted.status).toBe(200);
    const { inviteUrl } = await minted.json<{ inviteUrl: string }>();
    const token = inviteUrl.split("/join/")[1]!;

    // The session id is recoverable from the token, which is what lets the
    // Worker route straight to the owning object with no lookup table.
    expect(parseInviteToken(token)?.sessionId).toBe(sessionId);

    const joined = await post(`/api/session/invite/${token}/join`, {}, guest);
    expect(await joined.json()).toMatchObject({ success: true, sessionId });

    const replay = await post(`/api/session/invite/${token}/join`, {}, guest);
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ message: expect.stringContaining("already") });
  });

  it("refuses to mint an invite for someone else's session", async () => {
    const creator = await signedInUser("mine");
    const stranger = await signedInUser("yours");

    const { sessionId } = await (await post("/api/session/create", {}, creator)).json<{
      sessionId: string;
    }>();

    const attempt = await post(`/api/session/${sessionId}/invite`, {}, stranger);
    expect(attempt.status).toBe(403);
  });

  it("rejects a malformed invite token", async () => {
    const cookie = await signedInUser("malformed");

    const response = await post("/api/session/invite/not-a-real-token/join", {}, cookie);
    expect(response.status).toBe(400);
  });

  it("rejects a token whose secret has been tampered with", async () => {
    const creator = await signedInUser("tamper");
    const guest = await signedInUser("tamperguest");

    const { sessionId } = await (await post("/api/session/create", {}, creator)).json<{
      sessionId: string;
    }>();
    await post(`/api/session/${sessionId}/invite`, {}, creator);

    const forged = buildInviteToken(sessionId, "not-the-real-secret");
    const response = await post(`/api/session/invite/${forged}/join`, {}, guest);

    expect(response.status).toBe(400);
  });
});

describe("websocket upgrade", () => {
  it("refuses an unauthenticated upgrade before reaching the durable object", async () => {
    const response = await SELF.fetch(`${ORIGIN}/api/session/ws/anysession`, {
      headers: { Upgrade: "websocket" },
    });

    // Rejecting in the Worker means a flood costs one Worker request rather
    // than spinning up a Durable Object per connection.
    expect(response.status).toBe(401);
  });

  it("refuses a plain GET that is not an upgrade", async () => {
    const cookie = await signedInUser("notupgrade");
    const response = await request("/api/session/ws/anysession", {}, cookie);

    expect(response.status).toBe(426);
  });

  it("connects an authenticated user and announces them as the offerer", async () => {
    const cookie = await signedInUser("socket");
    const { sessionId } = await (await post("/api/session/create", {}, cookie)).json<{
      sessionId: string;
    }>();

    const response = await SELF.fetch(`${ORIGIN}/api/session/ws/${sessionId}`, {
      headers: { Upgrade: "websocket", Cookie: cookie },
    });

    expect(response.status).toBe(101);
    const ws = response.webSocket!;
    ws.accept();

    const joined = await new Promise<{ t: string; d: { isOfferer: boolean } }>((resolve) => {
      ws.addEventListener("message", (event) => resolve(JSON.parse(event.data as string)));
    });

    expect(joined.t).toBe("Joined");
    expect(joined.d.isOfferer).toBe(true);
  });
});

describe("invitation links", () => {
  it("enforces a single outstanding link for a regular user", async () => {
    const cookie = await signedInUser("quota");

    const first = await post("/api/invitation/generate-link", {}, cookie);
    expect(first.status).toBe(200);

    const second = await post("/api/invitation/generate-link", {}, cookie);
    expect(second.status).toBe(400);

    // Revoking hands the slot back.
    expect((await request("/api/invitation/revoke-link", { method: "DELETE" }, cookie)).status).toBe(200);
    expect((await post("/api/invitation/generate-link", {}, cookie)).status).toBe(200);
  });

  it("validates a link anonymously and names the inviter", async () => {
    const cookie = await signedInUser("inviter2");
    const { inviteUrl } = await (
      await post("/api/invitation/generate-link", {}, cookie)
    ).json<{ inviteUrl: string }>();
    const token = inviteUrl.split("/invite/")[1]!;

    // Anonymous: the signup screen calls this before an account exists.
    const response = await request(`/api/invitation/validate/${token}`);
    expect(await response.json()).toMatchObject({
      valid: true,
      inviterTag: expect.stringMatching(/^inviter2#\d{4}$/),
    });
  });

  it("reports an active link without revealing the token", async () => {
    const cookie = await signedInUser("active");
    await post("/api/invitation/generate-link", {}, cookie);

    const response = await request("/api/invitation/active-link", {}, cookie);
    const body = await response.json<Record<string, unknown>>();

    expect(body.hasActiveLink).toBe(true);
    // Only the hash is stored, so there is nothing to hand back.
    expect(JSON.stringify(body)).not.toContain("invite/");
  });

  it.each(["nonexistent-token", ""])("rejects invalid token %s", async (token) => {
    const response = await request(`/api/invitation/validate/${token}`);
    expect(response.status === 404 || (await response.clone().json<{ valid: boolean }>()).valid === false).toBe(
      true,
    );
  });
});

describe("rate limiting", () => {
  it("429s a burst of auth requests from one IP", async () => {
    const responses: number[] = [];
    // RL_AUTH allows 20/min; 30 from one IP must hit the wall.
    for (let i = 0; i < 30; i++) {
      const response = await post("/api/auth/passkey/auth/begin", {});
      responses.push(response.status);
    }

    expect(responses).toContain(429);
    expect(responses.filter((status) => status === 200).length).toBeLessThanOrEqual(20);
  });

  it("returns the body shape the frontend already parses", async () => {
    for (let i = 0; i < 30; i++) await post("/api/auth/passkey/auth/begin", {});

    const limited = await post("/api/auth/passkey/auth/begin", {});
    expect(limited.status).toBe(429);
    expect(limited.headers.get("Retry-After")).toBe("60");
    expect(await limited.json()).toMatchObject({
      message: expect.stringContaining("Too many"),
      retryAfterSeconds: 60,
    });
  });

  it("does not penalise a different IP", async () => {
    for (let i = 0; i < 30; i++) await post("/api/auth/passkey/auth/begin", {});

    // Buckets are per-IP, so one noisy client must not lock everyone out.
    const other = await SELF.fetch(`${ORIGIN}/api/auth/passkey/auth/begin`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "CF-Connecting-IP": "203.0.113.99" },
      body: "{}",
    });
    expect(other.status).toBe(200);
  });
});

describe("terms", () => {
  it("serves the current terms anonymously", async () => {
    const response = await request("/api/terms/current");
    const body = await response.json<{ version: string; content: string }>();

    // Against the constant, not a literal. This test is about the endpoint
    // serving whatever version is in force, and a hardcoded "1.0" made every
    // future bump of the terms text look like a broken route.
    expect(body.version).toBe(TERMS_VERSION);
    expect(body.content).toContain("WatchTogether");
  });

  it("records acceptance against the version", async () => {
    const cookie = await signedInUser("terms");

    const before = await (await request("/api/auth/me", {}, cookie)).json<{ hasAcceptedTerms: boolean }>();
    expect(before.hasAcceptedTerms).toBe(false);

    expect((await post("/api/terms/accept", {}, cookie)).status).toBe(200);

    const after = await (await request("/api/auth/me", {}, cookie)).json<{ hasAcceptedTerms: boolean }>();
    expect(after.hasAcceptedTerms).toBe(true);
  });
});

describe("admin", () => {
  async function rootCookie(): Promise<string> {
    const authenticator = await createTestAuthenticator(RP_ID);
    const begin = await post("/api/auth/passkey/setup/begin", {
      username: "rootuser",
      setupSecret: env.SETUP_SECRET,
    });
    const finish = await post("/api/auth/passkey/setup/finish", {
      response: await authenticator.register(
        (await begin.json<{ challenge: string }>()).challenge,
        ORIGIN,
      ),
    });
    return sessionCookie(finish)!;
  }

  it("refuses non-root callers", async () => {
    const cookie = await signedInUser("peasant");
    expect((await request("/api/admin/users", {}, cookie)).status).toBe(403);
  });

  it("refuses anonymous callers", async () => {
    expect((await request("/api/admin/users")).status).toBe(401);
  });

  it("lists users and builds the invite tree", async () => {
    const root = await rootCookie();
    await signedInUser("child");

    const listed = await request("/api/admin/users", {}, root);
    const { users } = await listed.json<{ users: { tag: string }[] }>();
    expect(users.length).toBeGreaterThan(1);
    expect(users.some((u) => u.tag === "rootuser#0000")).toBe(true);

    const tree = await request("/api/admin/user-tree", {}, root);
    const body = await tree.json<{ root: { tag: string; children: unknown[] }; totalUsers: number }>();
    expect(body.root.tag).toBe("rootuser#0000");
    expect(body.totalUsers).toBeGreaterThan(1);
  });

  it("will not delete the root user or yourself", async () => {
    const root = await rootCookie();
    const me = await (await request("/api/auth/me", {}, root)).json<{ tag: string }>();
    expect(me.tag).toBe("rootuser#0000");

    const rootRow = await db
      .prepare("SELECT id FROM users WHERE is_root = 1")
      .first<{ id: string }>();

    const response = await request(`/api/admin/users/${rootRow!.id}`, { method: "DELETE" }, root);
    expect(response.status).toBe(400);
  });

  it("deletes a user and writes an audit entry", async () => {
    const root = await rootCookie();
    await signedInUser("doomed");

    const victim = await db
      .prepare("SELECT id FROM users WHERE username_lower = 'doomed'")
      .first<{ id: string }>();

    expect((await request(`/api/admin/users/${victim!.id}`, { method: "DELETE" }, root)).status).toBe(200);

    const audit = await request("/api/admin/audit-log", {}, root);
    const { entries } = await audit.json<{ entries: { action: string; actor_tag: string }[] }>();
    expect(entries[0]).toMatchObject({ action: "DeleteUser", actor_tag: "rootuser#0000" });
  });
});
