import { countSignInMethods } from "./signInMethods";

export interface PasswordCredentialRow {
  user_id: string;
  password_hash: string;
  updated_at: number;
  last_used_at: number | null;
  failed_attempts: number;
  locked_until: number | null;
}

/**
 * Consecutive failures before the account is locked, and for how long.
 *
 * This is the layer that matters, because it is the only one that sees a
 * *distributed* attack on a single account — the RL_PASSWORD binding counts per
 * colo, which middleware/rateLimit.ts already owns up to.
 *
 * Fifteen minutes, not hours, and that is a deliberate ceiling rather than
 * timidity. Handles are semi-public, so anyone who knows one can hold an
 * account locked at will; a user with a passkey is on a different code path and
 * unaffected, but a password-only user has no way around it. Lengthening the
 * lock to "harden" the brute-force story would be hardening the denial of
 * service instead.
 */
export const LOCKOUT_THRESHOLD = 8;
export const LOCKOUT_DURATION_MS = 15 * 60 * 1000;

/**
 * Build the insert as a prepared statement so signup can batch it with the user
 * insert — D1's batch is one transaction, so an account can never be created
 * without a way to sign in to it. Mirrors insertCredentialStatement.
 */
export function insertPasswordCredentialStatement(
  db: D1Database,
  userId: string,
  passwordHash: string,
): D1PreparedStatement {
  return db
    .prepare(
      `INSERT INTO password_credentials (user_id, password_hash, updated_at)
       VALUES (?1, ?2, ?3)`,
    )
    .bind(userId, passwordHash, Date.now());
}

export function getPasswordCredential(
  db: D1Database,
  userId: string,
): Promise<PasswordCredentialRow | null> {
  return db
    .prepare("SELECT * FROM password_credentials WHERE user_id = ?")
    .bind(userId)
    .first<PasswordCredentialRow>();
}

/**
 * Set or replace a password, clearing any lockout with it.
 *
 * Proving you can set the password is strictly stronger evidence than surviving
 * the lockout would have been, so leaving the counter armed would only punish
 * the person who just recovered their account.
 */
export async function upsertPasswordCredential(
  db: D1Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO password_credentials (user_id, password_hash, updated_at)
       VALUES (?1, ?2, ?3)
       ON CONFLICT(user_id) DO UPDATE
         SET password_hash = ?2, updated_at = ?3, failed_attempts = 0, locked_until = NULL`,
    )
    .bind(userId, passwordHash, Date.now())
    .run();
}

/**
 * Remove a password, refusing to remove a user's last way in.
 *
 * The rule counts both credential types — see signInMethods.ts. deleteCredential
 * in credentials.ts enforces the same invariant from the passkey side.
 */
export async function deletePasswordCredential(
  db: D1Database,
  userId: string,
): Promise<"deleted" | "not_found" | "last_credential"> {
  const methods = await countSignInMethods(db, userId);
  if (!methods.hasPassword) return "not_found";
  if (methods.total <= 1) return "last_credential";

  await db.prepare("DELETE FROM password_credentials WHERE user_id = ?").bind(userId).run();
  return "deleted";
}

/**
 * Count a failed attempt, locking the account once the threshold is reached.
 *
 * The threshold test lives inside the UPDATE so two concurrent failures cannot
 * both read the same count and both decide it is still under the limit.
 */
export async function recordFailure(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE password_credentials
          SET failed_attempts = failed_attempts + 1,
              locked_until = CASE WHEN failed_attempts + 1 >= ?3 THEN ?2 ELSE locked_until END
        WHERE user_id = ?1`,
    )
    .bind(userId, Date.now() + LOCKOUT_DURATION_MS, LOCKOUT_THRESHOLD)
    .run();
}

export async function recordSuccess(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE password_credentials
          SET failed_attempts = 0, locked_until = NULL, last_used_at = ?2
        WHERE user_id = ?1`,
    )
    .bind(userId, Date.now())
    .run();
}

/**
 * Drop a lock that has run out, so the window slides rather than accumulating.
 *
 * Without this the counter would still be at the threshold after the lock
 * expired, and the very next failure would re-lock immediately — one wrong
 * attempt every fifteen minutes, forever.
 */
export async function clearExpiredLock(db: D1Database, userId: string): Promise<void> {
  await db
    .prepare(
      `UPDATE password_credentials
          SET failed_attempts = 0, locked_until = NULL
        WHERE user_id = ?1 AND locked_until IS NOT NULL AND locked_until <= ?2`,
    )
    .bind(userId, Date.now())
    .run();
}

/** Swap in a hash derived under current parameters. Nothing else changes. */
export async function rehashStoredPassword(
  db: D1Database,
  userId: string,
  passwordHash: string,
): Promise<void> {
  await db
    .prepare("UPDATE password_credentials SET password_hash = ? WHERE user_id = ?")
    .bind(passwordHash, userId)
    .run();
}
