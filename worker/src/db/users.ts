import {
  ROOT_DISCRIMINATOR,
  DISCRIMINATOR_MAX,
  formatTag,
  newDiscriminator,
} from "../lib/identity";
import { randomToken } from "../lib/crypto";

export interface UserRow {
  id: string;
  username: string;
  username_lower: string;
  discriminator: string;
  user_handle: string;
  is_root: number;
  active_link_count: number;
  invited_by_user_id: string | null;
  accepted_terms_at: number | null;
  terms_version: string | null;
  created_at: number;
  is_deleted: number;
  deleted_at: number | null;
  deleted_by_user_id: string | null;
}

/**
 * How many distinct discriminators one username may hold before allocation is
 * refused. Well under the 9999 ceiling so the retry loop never has to grind
 * through a nearly-full space.
 */
const USERNAME_SATURATION_LIMIT = 9000;

/** Redraws before giving up. At 100 users sharing a name, 8 failures is ~1e-16. */
const MAX_DISCRIMINATOR_ATTEMPTS = 8;

export type CreateUserResult =
  | { ok: true; user: UserRow }
  | { ok: false; error: "username_full" };

export interface CreateUserParams {
  username: string;
  usernameLower: string;
  invitedByUserId?: string | null;
  /**
   * Pre-generated identity, when the caller committed to it before the row
   * existed. Passkey registration does this: the id and handle are minted at
   * ceremony start and handed to the authenticator, so the row must adopt
   * exactly those values rather than inventing its own.
   */
  id?: string;
  userHandle?: string;
  /**
   * A statement to commit alongside the user — in practice the first passkey.
   * D1's batch is one transaction, so this guarantees an account can never
   * exist without a way to sign in to it.
   */
  credential?: D1PreparedStatement;
}

/** D1 surfaces constraint failures as errors carrying SQLite's message. */
function isUniqueViolation(error: unknown): boolean {
  return error instanceof Error && /UNIQUE constraint failed/i.test(error.message);
}

/**
 * Insert a user, allocating a free discriminator.
 *
 * Draws at random and lets the uniq_users_tag index arbitrate rather than
 * coordinating through a counter or a lock: a collision throws, we redraw, and
 * the uncontended case costs one round trip. Each attempt is a batch, so a
 * failed draw rolls back the credential insert with it.
 */
export async function createUser(
  db: D1Database,
  params: CreateUserParams,
): Promise<CreateUserResult> {
  // Cheap pre-check so a saturated name fails fast rather than burning every
  // retry on a space that is almost certainly full.
  const taken = await db
    .prepare("SELECT COUNT(*) AS n FROM users WHERE username_lower = ?")
    .bind(params.usernameLower)
    .first<{ n: number }>();

  if ((taken?.n ?? 0) >= USERNAME_SATURATION_LIMIT) return { ok: false, error: "username_full" };

  const id = params.id ?? crypto.randomUUID();
  const userHandle = params.userHandle ?? randomToken(32);
  const now = Date.now();

  for (let attempt = 0; attempt < MAX_DISCRIMINATOR_ATTEMPTS; attempt++) {
    const discriminator = newDiscriminator();

    const insertUser = db
      .prepare(
        `INSERT INTO users (id, username, username_lower, discriminator, user_handle,
                            created_at, invited_by_user_id)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(
        id,
        params.username,
        params.usernameLower,
        discriminator,
        userHandle,
        now,
        params.invitedByUserId ?? null,
      );

    try {
      await db.batch(params.credential ? [insertUser, params.credential] : [insertUser]);
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }

    const user = await getUserById(db, id);
    if (user) return { ok: true, user };
  }

  return { ok: false, error: "username_full" };
}

/**
 * Create the first account, which becomes root and always takes `#0000`.
 *
 * The `WHERE NOT EXISTS` makes "is the instance already set up?" and "claim
 * root" a single atomic statement. The .NET version checked and then inserted,
 * and its own comment conceded the race between the two.
 */
export async function createRootUser(
  db: D1Database,
  params: { username: string; usernameLower: string; userHandle?: string },
): Promise<UserRow | null> {
  const id = crypto.randomUUID();

  const result = await db
    .prepare(
      `INSERT INTO users (id, username, username_lower, discriminator, user_handle,
                          is_root, created_at)
       SELECT ?1, ?2, ?3, ?4, ?5, 1, ?6
       WHERE NOT EXISTS (SELECT 1 FROM users)`,
    )
    .bind(
      id,
      params.username,
      params.usernameLower,
      ROOT_DISCRIMINATOR,
      // Must match what the authenticator was handed during setup.
      params.userHandle ?? randomToken(32),
      Date.now(),
    )
    .run();

  return result.meta.changes === 1 ? getUserById(db, id) : null;
}

export function getUserById(db: D1Database, id: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE id = ? AND is_deleted = 0")
    .bind(id)
    .first<UserRow>();
}

export function getUserByHandle(db: D1Database, userHandle: string): Promise<UserRow | null> {
  return db
    .prepare("SELECT * FROM users WHERE user_handle = ? AND is_deleted = 0")
    .bind(userHandle)
    .first<UserRow>();
}

export function getUserByTag(
  db: D1Database,
  usernameLower: string,
  discriminator: string,
): Promise<UserRow | null> {
  return db
    .prepare(
      "SELECT * FROM users WHERE username_lower = ? AND discriminator = ? AND is_deleted = 0",
    )
    .bind(usernameLower, discriminator)
    .first<UserRow>();
}

/** Drives the first-run setup gate. Counts tombstones — setup is once, ever. */
export async function anyUserExists(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS n FROM users LIMIT 1").first<{ n: number }>();
  return row !== null;
}

export async function acceptTerms(
  db: D1Database,
  userId: string,
  termsVersion: string,
): Promise<void> {
  await db
    .prepare("UPDATE users SET accepted_terms_at = ?, terms_version = ? WHERE id = ?")
    .bind(Date.now(), termsVersion, userId)
    .run();
}

/**
 * Reserve one invite slot, atomically.
 *
 * The `active_link_count < ?` predicate lives in the UPDATE rather than in a
 * preceding SELECT, so two concurrent requests cannot both observe a free slot
 * and both take it. Returns false when the quota is already spent.
 */
export async function tryReserveInviteSlot(
  db: D1Database,
  userId: string,
  maxSlots: number,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE users SET active_link_count = active_link_count + 1
       WHERE id = ? AND active_link_count < ?`,
    )
    .bind(userId, maxSlots)
    .run();

  return result.meta.changes === 1;
}

/** Release a slot. Clamped at zero so a double-release cannot go negative. */
export async function releaseInviteSlot(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE users SET active_link_count = active_link_count - 1
       WHERE id = ? AND active_link_count > 0`,
    )
    .bind(userId)
    .run();
}

/**
 * Soft-delete a user and hard-delete their passkeys.
 *
 * Removing the credentials is not optional. The .NET soft delete left them in
 * place while the credential-uniqueness check ignored deleted users, so a
 * deleted account's authenticator was permanently unable to register again.
 * The username is released too, so the tag can be reissued.
 */
export async function softDeleteUser(
  db: D1Database,
  userId: string,
  deletedByUserId: string,
): Promise<void> {
  const now = Date.now();
  await db.batch([
    db.prepare("DELETE FROM passkey_credentials WHERE user_id = ?").bind(userId),
    db
      .prepare(
        `UPDATE users
         SET is_deleted = 1, deleted_at = ?, deleted_by_user_id = ?,
             username = '[deleted user]', username_lower = 'deleted-' || id
         WHERE id = ?`,
      )
      .bind(now, deletedByUserId, userId),
  ]);
}

/** `alice#0042` for display, admin listings and JWT claims. */
export function tagOf(user: Pick<UserRow, "username" | "discriminator">): string {
  return formatTag(user.username, user.discriminator);
}

export { DISCRIMINATOR_MAX, USERNAME_SATURATION_LIMIT };
