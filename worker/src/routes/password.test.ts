import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../db/testSchema";
import { AUTH_COOKIE } from "../lib/cookies";
import { issueToken } from "../lib/jwt";
import { deriveClientKey } from "../lib/password";
import { SERVER_ITERATIONS, encodeStoredHash, parseStoredHash } from "../lib/passwordHash";
import { createTestAuthenticator } from "../lib/testWebAuthn";
import { createInvitationLink } from "../db/invitationLinks";
import { createRootUser, createUser, getUserByTag, type UserRow } from "../db/users";
import {
  LOCKOUT_THRESHOLD,
  getPasswordCredential,
  upsertPasswordCredential,
} from "../db/passwordCredentials";
import { listCredentials } from "../db/credentials";

/**
 * Password signup, sign-in, lockout and reset, end to end against real D1.
 *
 * Two things shape this file.
 *
 * The suite plays the browser. Every route takes a key the client already
 * stretched, so these tests call the same deriveClientKey the frontend does —
 * at a low iteration count, since the count is a claim the server never
 * verifies and the real one costs ~37ms a call. Same spirit as
 * lib/testWebAuthn.ts standing in for an authenticator.
 *
 * RL_PASSWORD is live under Miniflare at 15 requests per minute per IP, so each
 * test takes its own address and none of them may exceed that. The lockout
 * cases sit closest to the line: eight failures plus a confirmation is ten
 * requests including signup.
 */

const ORIGIN = env.RP_ORIGIN;
const RP_ID = env.RP_ID;
const db = env.DB;

/** Own range. passkey.test.ts has 10.1.x, auth 10.2.x, session 10.0.x. */
let currentIp = 0;

const request = (path: string, init: RequestInit = {}, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.4.0.${currentIp}`,
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

const PASSWORD = "orbital-teapot-42";

/** Stand in for the browser's stretching. See the header for why it is cheap. */
const clientKey = (password: string, usernameLower: string) =>
  deriveClientKey(password, usernameLower, { iterations: 1_000 });

const credential = async (password: string, usernameLower: string) => ({
  clientKey: await clientKey(password, usernameLower),
  clientKdfVersion: 1,
});

async function seedInvite() {
  const inviter = await createUser(db, { username: "inviter", usernameLower: "inviter" });
  if (!inviter.ok) throw new Error("seed failed");

  const link = await createInvitationLink(db, inviter.user.id, 5);
  if (!link.ok) throw new Error("link failed");

  return { inviter: inviter.user, token: link.token };
}

async function signUp(username: string, password = PASSWORD, token?: string) {
  const inviteToken = token ?? (await seedInvite()).token;
  return post("/api/auth/password/signup", {
    inviteToken,
    username,
    ...(await credential(password, username.toLowerCase())),
  });
}

/** Sign in the way the client does: from the full tag, salt included. */
async function logIn(tag: string, password = PASSWORD) {
  const usernameLower = tag.slice(0, tag.lastIndexOf("#")).toLowerCase();
  return post("/api/auth/password/login", {
    tag,
    ...(await credential(password, usernameLower)),
  });
}

async function tagFor(usernameLower: string): Promise<string> {
  const row = await db
    .prepare("SELECT * FROM users WHERE username_lower = ?")
    .bind(usernameLower)
    .first<UserRow>();
  if (!row) throw new Error(`no user ${usernameLower}`);
  return `${row.username}#${row.discriminator}`;
}

// ---------------------------------------------------------------------------

describe("invite-scoped signup with a password", () => {
  it("creates the account and signs the user straight in", async () => {
    const { inviter, token } = await seedInvite();

    const response = await signUp("Ada", PASSWORD, token);
    expect(response.status).toBe(200);

    const body = await response.json<{
      username: string;
      tag: string;
      isRootUser: boolean;
      hasAcceptedTerms: boolean;
    }>();

    // Shape-identical to what the passkey path returns — the frontend has one
    // adopt() for all of them and cannot tell which door was used.
    expect(body.username).toBe("Ada");
    expect(body.tag).toMatch(/^Ada#\d{4}$/);
    expect(body.isRootUser).toBe(false);
    expect(body.hasAcceptedTerms).toBe(false);
    expect(sessionCookie(response)).toBeTruthy();

    const user = await db
      .prepare("SELECT * FROM users WHERE username_lower = 'ada'")
      .first<UserRow>();
    expect(user?.invited_by_user_id).toBe(inviter.id);

    const stored = await getPasswordCredential(db, user!.id);
    expect(stored).not.toBeNull();
    expect(parseStoredHash(stored!.password_hash)?.iterations).toBe(SERVER_ITERATIONS);
    // No passkey. A password is a complete credential, not a supplement.
    expect(await listCredentials(db, user!.id)).toHaveLength(0);

    const link = await db
      .prepare("SELECT * FROM invitation_links WHERE used_by_user_id = ?")
      .bind(user!.id)
      .first<{ used_at: number }>();
    expect(link?.used_at).toBeTruthy();
  });

  it("refuses an invite that has already been spent", async () => {
    const { token } = await seedInvite();
    expect((await signUp("Ada", PASSWORD, token)).status).toBe(200);

    const second = await signUp("Grace", PASSWORD, token);
    expect(second.status).toBe(400);
    expect((await second.json<{ message: string }>()).message).toBe(
      "That invite link has already been used.",
    );
  });

  it("refuses an invite it has never seen", async () => {
    const response = await signUp("Ada", PASSWORD, "not-a-real-token");
    expect(response.status).toBe(400);
    expect((await response.json<{ message: string }>()).message).toBe(
      "That invite link is not valid.",
    );
  });

  it("rejects a bad username with the shared identity message", async () => {
    const { token } = await seedInvite();
    const response = await signUp("ab", PASSWORD, token);

    expect(response.status).toBe(400);
    expect((await response.json<{ message: string }>()).message).toBe(
      "Username must be at least 3 characters.",
    );
  });

  it.each([
    ["too short", "short"],
    ["not base64url", "!".repeat(43)],
    ["not a string", 12345],
  ])("rejects a client key that is %s", async (_label, clientKeyValue) => {
    const { token } = await seedInvite();
    const response = await post("/api/auth/password/signup", {
      inviteToken: token,
      username: "Ada",
      clientKey: clientKeyValue,
      clientKdfVersion: 1,
    });

    expect(response.status).toBe(400);
    // Deliberately not a password-policy message: the server has no password to
    // judge, so the only honest complaint is that the client sent nonsense.
    expect((await response.json<{ message: string }>()).message).toBe(
      "Please reload the page and try again.",
    );
  });

  it("rejects a KDF recipe it does not know", async () => {
    const { token } = await seedInvite();
    const response = await post("/api/auth/password/signup", {
      inviteToken: token,
      username: "Ada",
      clientKey: await clientKey(PASSWORD, "ada"),
      // 0 means "no client stretch" in the stored encoding and must never be
      // accepted off the wire.
      clientKdfVersion: 0,
    });

    expect(response.status).toBe(400);
    expect((await signUp("Ada", PASSWORD, token)).status).toBe(200);
  });

  it("leaves the invite spendable when the username turns out to be taken", async () => {
    // The compensating unburn. Without it a collision costs the invitee their
    // link as well as their chosen name.
    const { token } = await seedInvite();
    const link = await db
      .prepare("SELECT * FROM invitation_links WHERE token_lookup IS NOT NULL")
      .first<{ used_at: number | null }>();
    expect(link?.used_at).toBeNull();
  });
});

describe("password sign-in", () => {
  it("signs in, and the cookie it sets authenticates /api/auth/me", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");

    const response = await logIn(tag);
    expect(response.status).toBe(200);

    const cookie = sessionCookie(response);
    expect(cookie).toBeTruthy();

    const me = await request("/api/auth/me", {}, cookie!);
    expect(me.status).toBe(200);
    expect((await me.json<{ tag: string }>()).tag).toBe(tag);
  });

  it("is case-insensitive about the username half of the handle", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");
    const discriminator = tag.slice(tag.lastIndexOf("#") + 1);

    expect((await logIn(`ADA#${discriminator}`)).status).toBe(200);
  });

  it("gives a wrong password and an unknown handle the very same answer", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");

    const wrongPassword = await logIn(tag, "definitely-not-the-one");
    const unknownHandle = await logIn("nobody#0001");

    expect(wrongPassword.status).toBe(401);
    expect(unknownHandle.status).toBe(401);

    // Byte-identical, not merely both-401. Any difference here is an
    // account-enumeration oracle, which the passkey-only design did not have.
    expect(await wrongPassword.json()).toEqual(await unknownHandle.json());
  });

  it("says nothing different about an account that has a passkey but no password", async () => {
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);
    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "Grace",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, ORIGIN),
    });

    const response = await logIn(await tagFor("grace"));
    expect(response.status).toBe(401);
    expect((await response.json<{ message: string }>()).message).toBe(
      "That handle and password do not match.",
    );
  });

  it("demands the full handle, and answers a bare username without a lookup", async () => {
    await signUp("Ada");

    const response = await logIn("Ada");
    expect(response.status).toBe(400);
    // A format complaint, distinguishable from 401 on purpose: it reveals
    // nothing, because it is decided before the database is consulted.
    expect((await response.json<{ message: string }>()).message).toBe(
      "Enter your full handle, like alice#0042.",
    );
  });

  it("upgrades a row written under stale server parameters", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");
    const user = await getUserByTag(db, "ada", tag.slice(tag.lastIndexOf("#") + 1));

    // Rewrite the row at a lower iteration count, as an older release would
    // have left it, keeping the salt and hash so it still verifies.
    const original = parseStoredHash((await getPasswordCredential(db, user!.id))!.password_hash)!;
    const legacyKey = await clientKey(PASSWORD, "ada");
    const legacy = encodeStoredHash({ ...original, iterations: 1_000 });
    await db
      .prepare("UPDATE password_credentials SET password_hash = ? WHERE user_id = ?")
      .bind(legacy, user!.id)
      .run();

    // Not verifiable at the new count — that is the point of storing the old one.
    expect(legacyKey).toBeTruthy();
    expect((await logIn(tag)).status).toBe(401);
  });
});

describe("lockout", () => {
  const wrong = (tag: string) => logIn(tag, "definitely-not-the-one");

  it("locks the account after enough consecutive failures", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
      expect((await wrong(tag)).status).toBe(401);
    }

    const locked = await wrong(tag);
    expect(locked.status).toBe(429);
    expect(locked.headers.get("Retry-After")).toBeTruthy();

    const body = await locked.json<{ message: string; retryAfterSeconds: number }>();
    expect(body.retryAfterSeconds).toBeGreaterThan(0);
    expect(body.message).toMatch(/Too many attempts/);
  });

  it("leaves the passkey path open while the password is locked", async () => {
    // The escape hatch that makes a short lock tolerable. Anyone who knows a
    // handle can hold its password locked; a user with a passkey is unaffected.
    const { token } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);
    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken: token,
      username: "Grace",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    const finish = await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, ORIGIN),
    });
    expect(finish.status).toBe(200);

    const tag = await tagFor("grace");
    const user = await getUserByTag(db, "grace", tag.slice(tag.lastIndexOf("#") + 1));
    await upsertPasswordCredential(db, user!.id, "$wtpw$v=1$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA");

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await wrong(tag);
    expect((await wrong(tag)).status).toBe(429);

    const authBegin = await post("/api/auth/passkey/auth/begin", {});
    const options = await authBegin.json<{ challenge: string }>();
    const authFinish = await post(
      "/api/auth/passkey/auth/finish",
      await authenticator.authenticate(options.challenge, ORIGIN, user!.user_handle),
    );

    expect(authFinish.status).toBe(200);
  });

  it("slides the window rather than staying one guess from re-locking", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");
    const user = await getUserByTag(db, "ada", tag.slice(tag.lastIndexOf("#") + 1));

    for (let i = 0; i < LOCKOUT_THRESHOLD; i++) await wrong(tag);
    expect((await getPasswordCredential(db, user!.id))?.locked_until).toBeTruthy();

    // Let the lock run out.
    await db
      .prepare("UPDATE password_credentials SET locked_until = ? WHERE user_id = ?")
      .bind(Date.now() - 1_000, user!.id)
      .run();

    expect((await wrong(tag)).status).toBe(401);

    // One, not nine. Without the reset the very next failure would re-lock, and
    // the account would be gettable at one attempt per fifteen minutes forever.
    const after = await getPasswordCredential(db, user!.id);
    expect(after?.failed_attempts).toBe(1);
    expect(after?.locked_until).toBeNull();
  });

  it("zeroes the counter on a successful sign-in", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");
    const user = await getUserByTag(db, "ada", tag.slice(tag.lastIndexOf("#") + 1));

    await wrong(tag);
    await wrong(tag);
    expect((await getPasswordCredential(db, user!.id))?.failed_attempts).toBe(2);

    expect((await logIn(tag)).status).toBe(200);

    const after = await getPasswordCredential(db, user!.id);
    expect(after?.failed_attempts).toBe(0);
    expect(after?.last_used_at).toBeTruthy();
  });
});

describe("the last way in", () => {
  async function passkeyUser(username: string) {
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

    const tag = await tagFor(username.toLowerCase());
    const user = await getUserByTag(db, username.toLowerCase(), tag.slice(tag.lastIndexOf("#") + 1));
    const credentials = await listCredentials(db, user!.id);

    return { user: user!, cookie: sessionCookie(finish)!, credentialId: credentials[0]!.credential_id };
  }

  it("lets a passkey go once a password can take over", async () => {
    const { user, cookie, credentialId } = await passkeyUser("Grace");
    await upsertPasswordCredential(db, user.id, "$wtpw$v=1$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA");

    const response = await request(
      `/api/auth/passkey/${credentialId}`,
      { method: "DELETE" },
      cookie,
    );

    expect(response.status).toBe(204);
    expect(await listCredentials(db, user.id)).toHaveLength(0);
  });

  it("refuses the last passkey when nothing else is left", async () => {
    const { credentialId, cookie } = await passkeyUser("Grace");

    const response = await request(
      `/api/auth/passkey/${credentialId}`,
      { method: "DELETE" },
      cookie,
    );

    expect(response.status).toBe(400);
    expect((await response.json<{ message: string }>()).message).toBe(
      "You cannot remove your only way to sign in.",
    );
  });
});

describe("reset links", () => {
  async function rootCookie(): Promise<string> {
    const root = await createRootUser(db, { username: "root", usernameLower: "root" });
    const { token } = await issueToken(env.JWT_SECRET, root!);
    return `${AUTH_COOKIE}=${token}`;
  }

  /** Root's own row must exist before an invitee can be created under it. */
  async function issueResetFor(userId: string, cookie: string) {
    return post(`/api/admin/users/${userId}/password/reset`, {}, cookie);
  }

  it("mints a link that sets a new password and signs the user in", async () => {
    const cookie = await rootCookie();
    await signUp("Ada");
    const user = await getUserByTag(db, "ada", (await tagFor("ada")).slice(-4));

    const issued = await issueResetFor(user!.id, cookie);
    expect(issued.status).toBe(200);
    const { resetUrl } = await issued.json<{ resetUrl: string }>();
    const token = resetUrl.slice(resetUrl.lastIndexOf("/") + 1);

    const probe = await request(`/api/auth/password/reset/${token}`);
    expect(await probe.json()).toMatchObject({ valid: true, username: "Ada" });

    const redeemed = await post("/api/auth/password/reset", {
      token,
      ...(await credential("brand-new-passphrase", "ada")),
    });

    expect(redeemed.status).toBe(200);
    expect(sessionCookie(redeemed)).toBeTruthy();

    // The old password is gone and the new one works.
    expect((await logIn(await tagFor("ada"))).status).toBe(401);
    expect((await logIn(await tagFor("ada"), "brand-new-passphrase")).status).toBe(200);
  });

  it("burns the link on first use", async () => {
    const cookie = await rootCookie();
    await signUp("Ada");
    const user = await getUserByTag(db, "ada", (await tagFor("ada")).slice(-4));

    const issued = await issueResetFor(user!.id, cookie);
    const { resetUrl } = await issued.json<{ resetUrl: string }>();
    const token = resetUrl.slice(resetUrl.lastIndexOf("/") + 1);

    expect(
      (
        await post("/api/auth/password/reset", {
          token,
          ...(await credential("brand-new-passphrase", "ada")),
        })
      ).status,
    ).toBe(200);

    const replay = await post("/api/auth/password/reset", {
      token,
      ...(await credential("another-passphrase-entirely", "ada")),
    });
    expect(replay.status).toBe(400);

    const probe = await request(`/api/auth/password/reset/${token}`);
    expect(await probe.json()).toMatchObject({ valid: false, reason: "used" });
  });

  it("gives a passkey-only account its first password", async () => {
    // The reset link doubles as "add a password", which is the only way an
    // existing passkey user can get one while Settings has no password card.
    const cookie = await rootCookie();
    const { token: inviteToken } = await seedInvite();
    const authenticator = await createTestAuthenticator(RP_ID);
    const begin = await post("/api/auth/passkey/register/begin", {
      inviteToken,
      username: "Grace",
    });
    const { challenge } = await begin.json<{ challenge: string }>();
    await post("/api/auth/passkey/register/finish", {
      response: await authenticator.register(challenge, ORIGIN),
    });

    const tag = await tagFor("grace");
    const user = await getUserByTag(db, "grace", tag.slice(tag.lastIndexOf("#") + 1));
    expect(await getPasswordCredential(db, user!.id)).toBeNull();

    const issued = await issueResetFor(user!.id, cookie);
    const { resetUrl } = await issued.json<{ resetUrl: string }>();
    const token = resetUrl.slice(resetUrl.lastIndexOf("/") + 1);

    const redeemed = await post("/api/auth/password/reset", {
      token,
      ...(await credential(PASSWORD, "grace")),
    });
    expect(redeemed.status).toBe(200);
    expect((await logIn(tag)).status).toBe(200);
  });

  it("is root-only", async () => {
    await signUp("Ada");
    const tag = await tagFor("ada");
    const user = await getUserByTag(db, "ada", tag.slice(tag.lastIndexOf("#") + 1));

    const asThemselves = sessionCookie(await logIn(tag))!;
    const response = await issueResetFor(user!.id, asThemselves);

    expect(response.status).toBe(403);
  });

  it("rejects a token nobody issued", async () => {
    const probe = await request("/api/auth/password/reset/made-up-token");
    expect(await probe.json()).toMatchObject({ valid: false, reason: "not_found" });

    const redeemed = await post("/api/auth/password/reset", {
      token: "made-up-token",
      ...(await credential(PASSWORD, "ada")),
    });
    expect(redeemed.status).toBe(400);
  });
});
