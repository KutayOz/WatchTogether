import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { loginResponse } from "../lib/loginResponse";
import { CLIENT_KEY_PATTERN, isClientKdfVersion } from "../lib/password";
import { dummyStoredHash, hashPassword, needsRehash, verifyPassword } from "../lib/passwordHash";
import { USERNAME_ERROR_MESSAGES, normalizeUsername, parseTag } from "../lib/identity";
import { createUser, getUserById, getUserByTag, tagOf } from "../db/users";
import {
  clearExpiredLock,
  getPasswordCredential,
  insertPasswordCredentialStatement,
  recordFailure,
  recordSuccess,
  rehashStoredPassword,
  upsertPasswordCredential,
} from "../db/passwordCredentials";
import { burnResetToken, findResetToken, resetValidity } from "../db/passwordResets";
import { burnLink, findLinkByToken, linkValidity, setLinkRedeemer, unburnLink } from "../db/invitationLinks";
import { appendAudit } from "../db/audit";

/**
 * Password sign-up and sign-in, a peer to the passkey routes rather than a
 * replacement for them. Passkeys remain the recommended door; they are simply
 * no longer the only one.
 *
 * ## What arrives here is not a password
 *
 * Every route below takes a `clientKey`: 32 bytes the browser already derived
 * from the password with PBKDF2 at 600,000 iterations, over a salt fixed by the
 * username. lib/password.ts explains why the work is split that way. Two
 * consequences that shape this file:
 *
 *   - The server cannot enforce password policy. Length, blocklist and
 *     username-containment are checked in the browser and nowhere else. What is
 *     enforced here is that the credential has the right *shape* and declares a
 *     recipe this build knows about.
 *   - The declared `clientKdfVersion` is a claim, not a proof. A client that
 *     lies and skips its own stretching weakens exactly one account: its own.
 *
 * ## Every 401 says the same thing
 *
 * Unknown handle, handle with no password set, and wrong password all return
 * one byte-identical body, and the miss path burns a real verification against
 * a dummy hash so it costs the same as a hit. Anything less is an
 * account-enumeration oracle, which the passkey-only design never had and this
 * one has to earn back.
 */
export const passwordRoutes = new Hono<AppEnv>();

/** One string, three failure modes. Never vary it. */
const CREDENTIALS_REJECTED = "That handle and password do not match.";

interface CredentialBody {
  clientKey?: unknown;
  clientKdfVersion?: unknown;
}

/**
 * The shape check that stands in for password validation.
 *
 * Returns the version rather than a boolean so callers record what produced the
 * hash they are about to store — `c=` in the stored encoding is what a future
 * migration would key off if the client recipe ever had to change.
 */
function readCredential(body: CredentialBody): { clientKey: string; version: number } | null {
  const { clientKey, clientKdfVersion } = body;
  if (typeof clientKey !== "string" || !CLIENT_KEY_PATTERN.test(clientKey)) return null;
  if (!isClientKdfVersion(clientKdfVersion)) return null;
  return { clientKey, version: clientKdfVersion };
}

/** The client is out of date, or someone is poking at the endpoint by hand. */
const MALFORMED_CREDENTIAL = "Please reload the page and try again.";

// ---------------------------------------------------------------------------
// Registration — anonymous, invite-scoped
//
// Mirrors the passkey path in routes/passkey.ts step for step, including the
// claim-then-create ordering and the compensating unburn, but in one request
// instead of two: there is no ceremony to run, so there is no challenge to
// stash in a Durable Object between calls.
// ---------------------------------------------------------------------------

passwordRoutes.post("/signup", async (c) => {
  const body = await c.req.json<{ inviteToken?: string; username?: string } & CredentialBody>();

  if (!body.inviteToken || !body.username) {
    return c.json({ message: "Invite token and username are required." }, 400);
  }

  const credential = readCredential(body);
  if (!credential) return c.json({ message: MALFORMED_CREDENTIAL }, 400);

  const username = normalizeUsername(body.username);
  if (!username.ok) return c.json({ message: USERNAME_ERROR_MESSAGES[username.error] }, 400);

  const link = await findLinkByToken(c.env.DB, body.inviteToken);
  const validity = linkValidity(link);

  // The passkey flow splits these across /begin and /finish; here there is only
  // one request, so both messages have to be reachable from it. "Spent" is
  // worth saying out loud — it is the one case where the invitee should go ask
  // for another link rather than assume they mistyped the URL.
  if (validity === "used") {
    return c.json({ message: "That invite link has already been used." }, 400);
  }
  if (validity !== "valid") {
    return c.json({ message: "That invite link is not valid." }, 400);
  }

  // Claim first. D1 has no interactive transactions, so a crash after this
  // costs the invitee a retry rather than handing out a second account. A
  // failure here is the race the check above cannot cover.
  if (!(await burnLink(c.env.DB, body.inviteToken))) {
    return c.json({ message: "That invite link has already been used." }, 400);
  }

  const userId = crypto.randomUUID();
  const passwordHash = await hashPassword(credential.clientKey, credential.version);

  const created = await createUser(c.env.DB, {
    username: username.value.username,
    usernameLower: username.value.usernameLower,
    invitedByUserId: link?.inviter_user_id,
    id: userId,
    // Batched with the user insert, so an account cannot exist without a way in.
    credentials: [insertPasswordCredentialStatement(c.env.DB, userId, passwordHash)],
  });

  if (!created.ok) {
    await unburnLink(c.env.DB, body.inviteToken);
    return c.json({ message: "That username is unavailable. Please pick another." }, 409);
  }

  await setLinkRedeemer(c.env.DB, body.inviteToken, created.user.id);

  return loginResponse(c, created.user);
});

// ---------------------------------------------------------------------------
// Sign-in
// ---------------------------------------------------------------------------

passwordRoutes.post("/login", async (c) => {
  const body = await c.req.json<{ tag?: string } & CredentialBody>();

  const credential = readCredential(body);
  if (!credential) return c.json({ message: MALFORMED_CREDENTIAL }, 400);

  /**
   * The full tag, not a bare username. Usernames are not unique — the pair is —
   * so accepting `alice` alone would either pick an arbitrary Alice or turn
   * this endpoint into a discriminator-enumeration engine.
   *
   * A malformed tag is answered as a format complaint without touching the
   * database, which is safe precisely because it says nothing about who exists.
   */
  const parsed = typeof body.tag === "string" ? parseTag(body.tag.trim()) : null;
  if (!parsed) return c.json({ message: "Enter your full handle, like alice#0042." }, 400);

  const username = normalizeUsername(parsed.username);
  if (!username.ok) return c.json({ message: "Enter your full handle, like alice#0042." }, 400);

  const user = await getUserByTag(c.env.DB, username.value.usernameLower, parsed.discriminator);
  const stored = user ? await getPasswordCredential(c.env.DB, user.id) : null;

  if (!user || !stored) {
    // Burn an equivalent verification so a miss costs what a hit costs. Without
    // this the two paths differ by roughly the whole KDF, which is trivially
    // measurable from outside.
    await verifyPassword(credential.clientKey, await dummyStoredHash());
    return c.json({ message: CREDENTIALS_REJECTED }, 401);
  }

  const now = Date.now();

  if (stored.locked_until !== null && stored.locked_until > now) {
    // Refused before the KDF runs, so a locked account cannot be used as a
    // CPU-burn amplifier. This response is a mild existence oracle — only a real
    // account can be locked — but it only fires against a handle the caller has
    // already failed on eight times, by which point they knew it existed.
    const retryAfterSeconds = Math.ceil((stored.locked_until - now) / 1000);
    return c.json(
      {
        message: `Too many attempts. Try again in ${Math.ceil(retryAfterSeconds / 60)} minutes.`,
        retryAfterSeconds,
      },
      429,
      { "Retry-After": String(retryAfterSeconds) },
    );
  }

  // A lock that has run out takes the failure count with it, so the window
  // slides instead of leaving the account one wrong guess from re-locking.
  if (stored.locked_until !== null) await clearExpiredLock(c.env.DB, user.id);

  if (!(await verifyPassword(credential.clientKey, stored.password_hash))) {
    await recordFailure(c.env.DB, user.id);
    return c.json({ message: CREDENTIALS_REJECTED }, 401);
  }

  await recordSuccess(c.env.DB, user.id);

  // Upgrade rows written under older server parameters, one sign-in at a time.
  // Deferred so a slow D1 write cannot sit in front of the response.
  if (needsRehash(stored.password_hash)) {
    c.executionCtx.waitUntil(
      hashPassword(credential.clientKey, credential.version).then((fresh) =>
        rehashStoredPassword(c.env.DB, user.id, fresh),
      ),
    );
  }

  return loginResponse(c, user);
});

// ---------------------------------------------------------------------------
// Reset
//
// There is no email address in this system, so there is no self-service path
// and no "forgot password" link to click. Root mints a single-use ticket from
// the admin dashboard and hands the link over out of band; these two routes are
// what the link talks to. Redeeming one signs the user in, so it also works as
// "add a password" for an account that never had one.
// ---------------------------------------------------------------------------

const RESET_REJECTED = "That reset link is not valid. Ask for a new one.";

/** Probe, so the reset screen can say "expired" before asking for a password. */
passwordRoutes.get("/reset/:token", async (c) => {
  const row = await findResetToken(c.env.DB, c.req.param("token"));
  const validity = resetValidity(row);
  if (validity !== "valid" || !row) return c.json({ valid: false, reason: validity });

  const user = await getUserById(c.env.DB, row.user_id);
  if (!user) return c.json({ valid: false, reason: "not_found" });

  // The username is needed client-side: it is the client-side salt, so the
  // browser cannot derive a key without it.
  return c.json({ valid: true, username: user.username, tag: tagOf(user) });
});

passwordRoutes.post("/reset", async (c) => {
  const body = await c.req.json<{ token?: string } & CredentialBody>();
  if (!body.token) return c.json({ message: RESET_REJECTED }, 400);

  const credential = readCredential(body);
  if (!credential) return c.json({ message: MALFORMED_CREDENTIAL }, 400);

  // Claimed atomically, so two redemptions of one link cannot both succeed.
  const ticket = await burnResetToken(c.env.DB, body.token);
  if (!ticket) return c.json({ message: RESET_REJECTED }, 400);

  const user = await getUserById(c.env.DB, ticket.user_id);
  if (!user) return c.json({ message: RESET_REJECTED }, 400);

  const passwordHash = await hashPassword(credential.clientKey, credential.version);
  await upsertPasswordCredential(c.env.DB, user.id, passwordHash);

  await appendAudit(c.env.DB, {
    actorUserId: ticket.issued_by,
    actorTag: "(reset link)",
    action: "PasswordResetCompleted",
    targetType: "User",
    targetId: user.id,
    details: `${tagOf(user)} set a new password`,
    ipAddress: c.req.header("CF-Connecting-IP") ?? undefined,
  });

  return loginResponse(c, user);
});
