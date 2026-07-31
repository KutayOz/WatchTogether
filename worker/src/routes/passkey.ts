import { Hono, type Context } from "hono";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
} from "@simplewebauthn/server";
import type { AuthenticationResponseJSON, RegistrationResponseJSON } from "@simplewebauthn/server";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { CHALLENGE_TTL_MS, type StoredChallenge } from "../do/AuthChallenge";
import { buildAuthCookie } from "../lib/cookies";
import { issueToken } from "../lib/jwt";
import { fromBase64Url, randomToken, sha256Hex, toBase64Url } from "../lib/crypto";
import { USERNAME_ERROR_MESSAGES, normalizeUsername } from "../lib/identity";
import { hasAcceptedCurrentTerms } from "../lib/terms";
import {
  createRootUser,
  createUser,
  getUserById,
  tagOf,
  type UserRow,
} from "../db/users";
import {
  deleteCredential,
  getCredentialById,
  insertCredential,
  insertCredentialStatement,
  listCredentials,
  parseTransports,
  updateCredentialCounter,
} from "../db/credentials";
import {
  burnLink,
  findLinkByToken,
  linkValidity,
  setLinkRedeemer,
  unburnLink,
} from "../db/invitationLinks";

const RP_NAME = "WatchTogether";

export const passkeyRoutes = new Hono<AppEnv>();

// ---------------------------------------------------------------------------
// Challenge storage
// ---------------------------------------------------------------------------

async function putChallenge(env: Env, challenge: StoredChallenge): Promise<void> {
  const stub = env.CHALLENGE.get(env.CHALLENGE.idFromName(challenge.challenge));
  await stub.fetch("https://do/put", { method: "POST", body: JSON.stringify(challenge) });
}

/**
 * Consume a challenge, identified from the ceremony response itself.
 *
 * The browser echoes the challenge back inside clientDataJSON, so no ceremony
 * id has to be tracked client-side — the same trick the .NET auth path used
 * (PasskeyService.cs:184-190), here applied to registration as well.
 */
async function consumeChallenge(
  env: Env,
  clientDataJSON: string,
): Promise<StoredChallenge | null> {
  let challenge: string;
  try {
    const clientData = JSON.parse(new TextDecoder().decode(fromBase64Url(clientDataJSON))) as {
      challenge?: string;
    };
    if (!clientData.challenge) return null;
    challenge = clientData.challenge;
  } catch {
    return null;
  }

  const stub = env.CHALLENGE.get(env.CHALLENGE.idFromName(challenge));
  const response = await stub.fetch("https://do/consume", { method: "POST" });
  const body = await response.json<{ ok: boolean; challenge?: StoredChallenge }>();

  return body.ok && body.challenge ? body.challenge : null;
}

/**
 * Issue a session and describe the signed-in user.
 *
 * The single place a session cookie is minted, so its lifetime cannot diverge
 * from the token's the way it did across two controllers in the .NET app.
 */
async function loginResponse(c: Context<AppEnv>, user: UserRow) {
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

// ---------------------------------------------------------------------------
// Registration — anonymous, invite-scoped
//
// Net-new. In the .NET app both registration endpoints were [Authorize]
// (PasskeyController.cs:47,65), so a passkey could only ever be added to an
// account that already existed via password. With passwords gone, an invitee
// holding nothing but a link has to be able to create an account.
// ---------------------------------------------------------------------------

passkeyRoutes.post("/register/begin", async (c) => {
  const { inviteToken, username: rawUsername } = await c.req.json<{
    inviteToken?: string;
    username?: string;
  }>();

  if (!inviteToken || !rawUsername) {
    return c.json({ message: "Invite token and username are required." }, 400);
  }

  const normalized = normalizeUsername(rawUsername);
  if (!normalized.ok) {
    return c.json({ message: USERNAME_ERROR_MESSAGES[normalized.error] }, 400);
  }

  const link = await findLinkByToken(c.env.DB, inviteToken);
  if (linkValidity(link) !== "valid") {
    return c.json({ message: "That invite link is not valid." }, 400);
  }

  // The user is NOT created here — an abandoned ceremony would otherwise leave
  // an accountless row holding a username. Instead the identity is minted now
  // and carried in the challenge, so the id and user handle that reach the
  // authenticator are the exact ones later written to the database.
  //
  // This is the fix for the .NET bug where EnsureUserHandle ran twice without
  // persisting (PasskeyService.cs:55 and :138): the first credential was
  // issued one handle and the database recorded a different one.
  const userId = crypto.randomUUID();
  const userHandle = randomToken(32);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: c.env.RP_ID,
    userID: fromBase64Url(userHandle),
    userName: normalized.value.username,
    userDisplayName: normalized.value.username,
    attestationType: "none",
    authenticatorSelection: {
      // Required, not preferred. Discoverable credentials are what make
      // usernameless login possible, and with no email to scope a credential
      // list by, usernameless is the only login flow there is.
      residentKey: "required",
      userVerification: "preferred",
    },
  });

  await putChallenge(c.env, {
    kind: "reg-new",
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    userId,
    userHandle,
    username: normalized.value.username,
    usernameLower: normalized.value.usernameLower,
    inviteTokenLookup: inviteToken,
  });

  return c.json(options);
});

passkeyRoutes.post("/register/finish", async (c) => {
  const body = await c.req.json<{ response?: RegistrationResponseJSON; label?: string }>();
  if (!body.response) return c.json({ message: "Missing registration response." }, 400);

  const stored = await consumeChallenge(c.env, body.response.response.clientDataJSON);
  if (!stored) return c.json({ message: "Registration expired. Please try again." }, 400);

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: stored.challenge,
      expectedOrigin: c.env.RP_ORIGIN,
      expectedRPID: c.env.RP_ID,
    });
  } catch {
    return c.json({ message: "Registration could not be verified." }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ message: "Registration could not be verified." }, 400);
  }

  const { credential, aaguid, credentialBackedUp, credentialDeviceType } =
    verification.registrationInfo;
  const label = body.label?.trim() || `Passkey added ${new Date().toISOString().slice(0, 10)}`;

  // --- Adding a passkey to an existing account -----------------------------
  if (stored.kind === "reg-add" && stored.existingUserId) {
    await insertCredential(c.env.DB, {
      credentialId: credential.id,
      userId: stored.existingUserId,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      aaguid,
      backupEligible: credentialDeviceType === "multiDevice",
      backedUp: credentialBackedUp,
      label,
    });
    return c.json({ label });
  }

  // --- Creating a new account ---------------------------------------------
  if (
    stored.kind !== "reg-new" ||
    !stored.userId ||
    !stored.username ||
    !stored.usernameLower ||
    !stored.inviteTokenLookup
  ) {
    return c.json({ message: "Registration could not be verified." }, 400);
  }

  // Read the inviter before claiming, so the link only has to be looked up once.
  const link = await findLinkByToken(c.env.DB, stored.inviteTokenLookup);

  // Claim the invite first. D1 has no interactive transactions, so this cannot
  // share a transaction with the inserts below; claiming first means a crash
  // costs the invitee a retry rather than handing out a second account.
  if (!(await burnLink(c.env.DB, stored.inviteTokenLookup))) {
    return c.json({ message: "That invite link has already been used." }, 400);
  }

  const created = await createUser(c.env.DB, {
    username: stored.username,
    usernameLower: stored.usernameLower,
    invitedByUserId: link?.inviter_user_id,
    // Identity was fixed at /begin so it matches what the authenticator holds.
    id: stored.userId,
    userHandle: stored.userHandle,
    // Batched with the user insert, so an account cannot exist without a passkey.
    credential: insertCredentialStatement(c.env.DB, {
      credentialId: credential.id,
      userId: stored.userId,
      publicKey: toBase64Url(credential.publicKey),
      counter: credential.counter,
      transports: credential.transports,
      aaguid,
      backupEligible: credentialDeviceType === "multiDevice",
      backedUp: credentialBackedUp,
      label,
    }),
  });

  if (!created.ok) {
    // Compensating action: release the invite so it is not spent on an account
    // that was never created. The nightly cron reconciles slot counts anyway.
    await unburnLink(c.env.DB, stored.inviteTokenLookup);
    return c.json({ message: "That username is unavailable. Please pick another." }, 409);
  }

  // Now that the user exists, the foreign key can be satisfied.
  await setLinkRedeemer(c.env.DB, stored.inviteTokenLookup, created.user.id);

  return loginResponse(c, created.user);
});

// ---------------------------------------------------------------------------
// Adding a passkey to the signed-in account
// ---------------------------------------------------------------------------

passkeyRoutes.post("/register/add/begin", requireAuth, async (c) => {
  const user = c.get("user");
  const existing = await listCredentials(c.env.DB, user.id);

  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: c.env.RP_ID,
    // Read from the user row, never regenerated — this is the invariant the
    // .NET code broke.
    userID: fromBase64Url(user.user_handle),
    userName: user.username,
    userDisplayName: user.username,
    attestationType: "none",
    excludeCredentials: existing.map((row) => ({
      id: row.credential_id,
      transports: parseTransports(row) as never,
    })),
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });

  await putChallenge(c.env, {
    kind: "reg-add",
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    existingUserId: user.id,
  });

  return c.json(options);
});

// ---------------------------------------------------------------------------
// Authentication — usernameless
// ---------------------------------------------------------------------------

passkeyRoutes.post("/auth/begin", async (c) => {
  // No allowCredentials, and no optional email to scope them by. Besides being
  // the only option once email is gone, this removes the account-enumeration
  // surface the .NET version needed a constant-time workaround for.
  const options = await generateAuthenticationOptions({
    rpID: c.env.RP_ID,
    userVerification: "preferred",
  });

  await putChallenge(c.env, {
    kind: "auth",
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
  });

  return c.json(options);
});

passkeyRoutes.post("/auth/finish", async (c) => {
  const response = await c.req.json<AuthenticationResponseJSON>();
  if (!response?.response?.clientDataJSON) {
    return c.json({ message: "Missing authentication response." }, 400);
  }

  const stored = await consumeChallenge(c.env, response.response.clientDataJSON);
  if (!stored || stored.kind !== "auth") {
    return c.json({ message: "Sign-in expired. Please try again." }, 400);
  }

  const credential = await getCredentialById(c.env.DB, response.id);
  if (!credential) return c.json({ message: "Unknown passkey." }, 401);

  const user = await getUserById(c.env.DB, credential.user_id);
  if (!user) return c.json({ message: "Unknown passkey." }, 401);

  // The user handle the authenticator returns must match the one on record.
  // One string comparison replaces the callback indirection in the .NET code.
  if (response.response.userHandle && response.response.userHandle !== user.user_handle) {
    return c.json({ message: "Unknown passkey." }, 401);
  }

  let verification;
  try {
    verification = await verifyAuthenticationResponse({
      response,
      expectedChallenge: stored.challenge,
      expectedOrigin: c.env.RP_ORIGIN,
      expectedRPID: c.env.RP_ID,
      credential: {
        id: credential.credential_id,
        publicKey: fromBase64Url(credential.public_key),
        counter: credential.counter,
        transports: parseTransports(credential) as never,
      },
    });
  } catch {
    return c.json({ message: "Sign-in could not be verified." }, 401);
  }

  if (!verification.verified) return c.json({ message: "Sign-in could not be verified." }, 401);

  await updateCredentialCounter(
    c.env.DB,
    credential.credential_id,
    verification.authenticationInfo.newCounter,
  );

  return loginResponse(c, user);
});

// ---------------------------------------------------------------------------
// Managing credentials
// ---------------------------------------------------------------------------

passkeyRoutes.get("/", requireAuth, async (c) => {
  const rows = await listCredentials(c.env.DB, c.get("user").id);

  return c.json({
    items: rows.map((row) => ({
      credentialId: row.credential_id,
      label: row.label,
      aaguid: row.aaguid,
      registeredAt: row.registered_at,
      lastUsedAt: row.last_used_at,
      backedUp: row.backed_up === 1,
    })),
  });
});

passkeyRoutes.delete("/:credentialId", requireAuth, async (c) => {
  const outcome = await deleteCredential(
    c.env.DB,
    c.get("user").id,
    c.req.param("credentialId"),
  );

  if (outcome === "not_found") return c.json({ message: "Passkey not found." }, 404);
  if (outcome === "last_credential") {
    // With passwords gone there is no other way back in.
    return c.json({ message: "You cannot remove your only passkey." }, 400);
  }
  return c.body(null, 204);
});

// ---------------------------------------------------------------------------
// First-run bootstrap
// ---------------------------------------------------------------------------

passkeyRoutes.post("/setup/begin", async (c) => {
  const { username: rawUsername, setupSecret } = await c.req.json<{
    username?: string;
    setupSecret?: string;
  }>();

  // Gated by a deployment secret as well as by emptiness, so the window
  // between deploying and registering is not an open door.
  if (!setupSecret || (await sha256Hex(setupSecret)) !== (await sha256Hex(c.env.SETUP_SECRET))) {
    return c.json({ message: "Setup is not available." }, 403);
  }
  if (!rawUsername) return c.json({ message: "Username is required." }, 400);

  const normalized = normalizeUsername(rawUsername);
  if (!normalized.ok) {
    return c.json({ message: USERNAME_ERROR_MESSAGES[normalized.error] }, 400);
  }

  const userHandle = randomToken(32);
  const options = await generateRegistrationOptions({
    rpName: RP_NAME,
    rpID: c.env.RP_ID,
    userID: fromBase64Url(userHandle),
    userName: normalized.value.username,
    userDisplayName: normalized.value.username,
    attestationType: "none",
    authenticatorSelection: { residentKey: "required", userVerification: "preferred" },
  });

  await putChallenge(c.env, {
    kind: "reg-new",
    challenge: options.challenge,
    expiresAt: Date.now() + CHALLENGE_TTL_MS,
    userId: crypto.randomUUID(),
    userHandle,
    username: normalized.value.username,
    usernameLower: normalized.value.usernameLower,
    // No invite: rootness is claimed by the database being empty.
  });

  return c.json(options);
});

passkeyRoutes.post("/setup/finish", async (c) => {
  const body = await c.req.json<{ response?: RegistrationResponseJSON }>();
  if (!body.response) return c.json({ message: "Missing registration response." }, 400);

  const stored = await consumeChallenge(c.env, body.response.response.clientDataJSON);
  if (!stored || stored.kind !== "reg-new" || !stored.username || !stored.usernameLower) {
    return c.json({ message: "Setup expired. Please try again." }, 400);
  }

  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: body.response,
      expectedChallenge: stored.challenge,
      expectedOrigin: c.env.RP_ORIGIN,
      expectedRPID: c.env.RP_ID,
    });
  } catch {
    return c.json({ message: "Setup could not be verified." }, 400);
  }

  if (!verification.verified || !verification.registrationInfo) {
    return c.json({ message: "Setup could not be verified." }, 400);
  }

  // Claiming root and checking that nobody holds it are one statement, so
  // concurrent callers cannot both win.
  const root = await createRootUser(c.env.DB, {
    username: stored.username,
    usernameLower: stored.usernameLower,
    userHandle: stored.userHandle,
  });
  if (!root) return c.json({ message: "Setup has already been completed." }, 403);

  const { credential, aaguid, credentialBackedUp, credentialDeviceType } =
    verification.registrationInfo;

  await insertCredential(c.env.DB, {
    credentialId: credential.id,
    userId: root.id,
    publicKey: toBase64Url(credential.publicKey),
    counter: credential.counter,
    transports: credential.transports,
    aaguid,
    backupEligible: credentialDeviceType === "multiDevice",
    backedUp: credentialBackedUp,
    label: "Root passkey",
  });

  return loginResponse(c, root);
});
