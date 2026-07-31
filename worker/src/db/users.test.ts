import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import schema from "../../migrations/0001_init.sql?raw";
import { applySchema } from "./testSchema";
import {
  anyUserExists,
  createRootUser,
  createUser,
  getUserById,
  releaseInviteSlot,
  softDeleteUser,
  tagOf,
  tryReserveInviteSlot,
  USERNAME_SATURATION_LIMIT,
} from "./users";
import { randomToken } from "../lib/crypto";

const db = env.DB;

beforeEach(async () => {
  await db.batch(
    ["admin_audit_log", "revoked_tokens", "invitation_links", "passkey_credentials", "users"].map(
      (table) => db.prepare(`DROP TABLE IF EXISTS ${table}`),
    ),
  );
  await applySchema(db, schema);
});

describe("createUser", () => {
  it("allocates a tag and persists the user", async () => {
    const result = await createUser(db, { username: "Alice", usernameLower: "alice" });

    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.user.username).toBe("Alice");
    expect(result.user.discriminator).toMatch(/^\d{4}$/);
    expect(tagOf(result.user)).toBe(`Alice#${result.user.discriminator}`);
    // Generated once at creation and never re-derived, so the WebAuthn
    // credential and this row can never disagree about it.
    expect(result.user.user_handle).toHaveLength(43);
  });

  it("gives every user of the same name a distinct discriminator", async () => {
    const seen = new Set<string>();

    for (let i = 0; i < 60; i++) {
      const result = await createUser(db, { username: "alice", usernameLower: "alice" });
      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(seen.has(result.user.discriminator)).toBe(false);
      seen.add(result.user.discriminator);
    }

    expect(seen.size).toBe(60);
  });

  it("lets different names reuse the same discriminator", async () => {
    const alice = await createUser(db, { username: "alice", usernameLower: "alice" });
    expect(alice.ok).toBe(true);
    if (!alice.ok) return;

    // Uniqueness is on the pair, not the discriminator alone.
    const inserted = await db
      .prepare(
        `INSERT INTO users (id, username, username_lower, discriminator, user_handle, created_at)
         VALUES (?, 'bob', 'bob', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), alice.user.discriminator, randomToken(32), Date.now())
      .run();

    expect(inserted.meta.changes).toBe(1);
  });

  it("refuses a saturated username instead of spinning through retries", async () => {
    // Fill the name straight to the limit rather than through createUser, which
    // would take 9,000 round trips.
    const rows = Array.from({ length: USERNAME_SATURATION_LIMIT }, (_, i) =>
      db
        .prepare(
          `INSERT INTO users (id, username, username_lower, discriminator, user_handle, created_at)
           VALUES (?, 'full', 'full', ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), String(i + 1).padStart(4, "0"), randomToken(32), Date.now()),
    );

    for (let i = 0; i < rows.length; i += 500) await db.batch(rows.slice(i, i + 500));

    expect(await createUser(db, { username: "full", usernameLower: "full" })).toEqual({
      ok: false,
      error: "username_full",
    });
  });

  it("records who invited whom", async () => {
    const inviter = await createUser(db, { username: "inviter", usernameLower: "inviter" });
    expect(inviter.ok).toBe(true);
    if (!inviter.ok) return;

    const invitee = await createUser(db, {
      username: "invitee",
      usernameLower: "invitee",
      invitedByUserId: inviter.user.id,
    });

    expect(invitee.ok && invitee.user.invited_by_user_id).toBe(inviter.user.id);
  });
});

describe("createRootUser", () => {
  it("claims root with the reserved 0000 discriminator", async () => {
    const root = await createRootUser(db, { username: "kutay", usernameLower: "kutay" });

    expect(root?.is_root).toBe(1);
    expect(root?.discriminator).toBe("0000");
    expect(await anyUserExists(db)).toBe(true);
  });

  it("refuses once any user exists", async () => {
    await createUser(db, { username: "someone", usernameLower: "someone" });

    // The WHERE NOT EXISTS makes the check and the claim one statement, so
    // there is no window between them to race through.
    expect(await createRootUser(db, { username: "kutay", usernameLower: "kutay" })).toBeNull();
  });

  it("admits only one winner when called concurrently", async () => {
    const attempts = await Promise.all(
      Array.from({ length: 8 }, (_, i) =>
        createRootUser(db, { username: `root${i}`, usernameLower: `root${i}` }),
      ),
    );

    expect(attempts.filter((user) => user !== null)).toHaveLength(1);
  });
});

describe("invite slots", () => {
  it("hands out no more than the quota", async () => {
    const user = await createUser(db, { username: "quota", usernameLower: "quota" });
    expect(user.ok).toBe(true);
    if (!user.ok) return;

    expect(await tryReserveInviteSlot(db, user.user.id, 1)).toBe(true);
    expect(await tryReserveInviteSlot(db, user.user.id, 1)).toBe(false);

    await releaseInviteSlot(db, user.user.id);
    expect(await tryReserveInviteSlot(db, user.user.id, 1)).toBe(true);
  });

  it("never lets the counter go negative on a double release", async () => {
    const user = await createUser(db, { username: "release", usernameLower: "release" });
    expect(user.ok).toBe(true);
    if (!user.ok) return;

    await releaseInviteSlot(db, user.user.id);
    await releaseInviteSlot(db, user.user.id);

    const row = await db
      .prepare("SELECT active_link_count AS n FROM users WHERE id = ?")
      .bind(user.user.id)
      .first<{ n: number }>();

    expect(row?.n).toBe(0);
  });
});

describe("softDeleteUser", () => {
  it("removes passkeys so the authenticator can register again", async () => {
    const actor = await createUser(db, { username: "admin1", usernameLower: "admin1" });
    const victim = await createUser(db, { username: "victim", usernameLower: "victim" });
    expect(actor.ok && victim.ok).toBe(true);
    if (!actor.ok || !victim.ok) return;

    const credentialId = randomToken(16);
    await db
      .prepare(
        `INSERT INTO passkey_credentials
           (credential_id, user_id, public_key, label, registered_at)
         VALUES (?, ?, ?, 'laptop', ?)`,
      )
      .bind(credentialId, victim.user.id, randomToken(64), Date.now())
      .run();

    await softDeleteUser(db, victim.user.id, actor.user.id);

    // The .NET soft delete left credentials behind while the uniqueness check
    // ignored deleted users, which permanently blocked that authenticator.
    const orphan = await db
      .prepare("SELECT 1 AS n FROM passkey_credentials WHERE credential_id = ?")
      .bind(credentialId)
      .first();

    expect(orphan).toBeNull();
    expect(await getUserById(db, victim.user.id)).toBeNull();
  });

  it("frees the username for reuse", async () => {
    const actor = await createUser(db, { username: "admin2", usernameLower: "admin2" });
    const victim = await createUser(db, { username: "taken", usernameLower: "taken" });
    expect(actor.ok && victim.ok).toBe(true);
    if (!actor.ok || !victim.ok) return;

    await softDeleteUser(db, victim.user.id, actor.user.id);

    const reused = await createUser(db, { username: "taken", usernameLower: "taken" });
    expect(reused.ok).toBe(true);
  });
});
