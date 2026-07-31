/**
 * JWT deny-list.
 *
 * Rows are keyed by `jti` and only need to outlive the token itself — once a
 * JWT would have expired anyway, its entry is dead weight. Mongo swept these
 * with a TTL index; here the nightly cron calls sweepExpired.
 */

export async function revokeToken(
  db: D1Database,
  jti: string,
  userId: string,
  expiresAtUnixSeconds: number,
): Promise<void> {
  await db
    .prepare(
      `INSERT INTO revoked_tokens (jti, user_id, expires_at, revoked_at)
       VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(jti) DO NOTHING`,
    )
    .bind(jti, userId, expiresAtUnixSeconds * 1000, Date.now())
    .run();
}

/** One indexed primary-key lookup, run on every authenticated request. */
export async function isTokenRevoked(db: D1Database, jti: string): Promise<boolean> {
  const row = await db
    .prepare("SELECT 1 AS n FROM revoked_tokens WHERE jti = ?")
    .bind(jti)
    .first<{ n: number }>();
  return row !== null;
}

export async function sweepExpired(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM revoked_tokens WHERE expires_at < ?")
    .bind(Date.now())
    .run();
  return result.meta.changes;
}
