import { randomToken, sha256Hex } from "../lib/crypto";

/** Matches the invite TTL. Long enough to hand over out of band, short enough to expire. */
export const RESET_TTL_MS = 48 * 60 * 60 * 1000;

export interface PasswordResetRow {
  token_lookup: string;
  user_id: string;
  issued_by: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
}

/**
 * Mint a reset ticket for a user. Root only; the caller enforces that.
 *
 * The raw token is returned once and never stored, only its SHA-256 — the same
 * treatment invite tokens get, and for the same reason: 256 bits of entropy has
 * no guessing attack for a slow hash to protect against, but a leaked table
 * should not hand out working links.
 *
 * Outstanding tickets for the same user are dropped first. Two live reset links
 * for one account is one more than anybody needs, and revoking by reissuing is
 * a useful property for whoever is holding the pieces of a support problem.
 */
export async function createResetToken(
  db: D1Database,
  userId: string,
  issuedBy: string,
): Promise<{ token: string; expiresAt: number }> {
  const token = randomToken(32);
  const now = Date.now();
  const expiresAt = now + RESET_TTL_MS;

  await db.batch([
    db
      .prepare("DELETE FROM password_reset_tokens WHERE user_id = ? AND used_at IS NULL")
      .bind(userId),
    db
      .prepare(
        `INSERT INTO password_reset_tokens (token_lookup, user_id, issued_by, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(await sha256Hex(token), userId, issuedBy, now, expiresAt),
  ]);

  return { token, expiresAt };
}

export async function findResetToken(
  db: D1Database,
  token: string,
): Promise<PasswordResetRow | null> {
  return db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_lookup = ?")
    .bind(await sha256Hex(token))
    .first<PasswordResetRow>();
}

export type ResetValidity = "valid" | "not_found" | "expired" | "used";

export function resetValidity(row: PasswordResetRow | null): ResetValidity {
  if (!row) return "not_found";
  if (row.used_at !== null) return "used";
  if (row.expires_at <= Date.now()) return "expired";
  return "valid";
}

/**
 * Claim a ticket, atomically. Returns the claimed row, or null if it was
 * already spent or has expired.
 *
 * Every precondition is in the UPDATE's WHERE clause, so two concurrent
 * redemptions cannot both observe an unused ticket — the same shape as
 * burnLink. The row is read back only after the write has established
 * exclusivity, so the follow-up SELECT cannot race anything.
 */
export async function burnResetToken(
  db: D1Database,
  token: string,
): Promise<PasswordResetRow | null> {
  const lookup = await sha256Hex(token);

  const result = await db
    .prepare(
      `UPDATE password_reset_tokens SET used_at = ?1
        WHERE token_lookup = ?2 AND used_at IS NULL AND expires_at > ?1`,
    )
    .bind(Date.now(), lookup)
    .run();

  if (result.meta.changes !== 1) return null;

  return db
    .prepare("SELECT * FROM password_reset_tokens WHERE token_lookup = ?")
    .bind(lookup)
    .first<PasswordResetRow>();
}

/**
 * Drop spent and expired tickets. Called by the nightly cron, because D1 has no
 * TTL index and an unswept table only ever grows.
 *
 * Used tickets go too, unlike invitation_links where `used_by_user_id` is an
 * audit trail worth keeping — admin_audit_log already records both the issue
 * and the redemption, so there is nothing here to preserve.
 */
export async function sweepExpiredResetTokens(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM password_reset_tokens WHERE expires_at <= ? OR used_at IS NOT NULL")
    .bind(Date.now())
    .run();

  return result.meta.changes;
}
