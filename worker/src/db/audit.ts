/**
 * Admin audit trail. Append-only by design — there is no update or delete here,
 * and none should be added.
 */

export interface AuditEntry {
  actorUserId: string;
  /** `username#1234` snapshot, so the record still reads correctly after a rename. */
  actorTag: string;
  action: string;
  targetType: string;
  targetId: string;
  details?: string;
  ipAddress?: string;
}

export async function appendAudit(db: D1Database, entry: AuditEntry): Promise<void> {
  await db
    .prepare(
      `INSERT INTO admin_audit_log
         (id, actor_user_id, actor_tag, action, target_type, target_id, details, ip_address, created_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)`,
    )
    .bind(
      crypto.randomUUID(),
      entry.actorUserId,
      entry.actorTag,
      entry.action,
      entry.targetType,
      entry.targetId,
      entry.details ?? null,
      entry.ipAddress ?? null,
      Date.now(),
    )
    .run();
}

export async function listAudit(db: D1Database, limit: number) {
  const { results } = await db
    .prepare("SELECT * FROM admin_audit_log ORDER BY created_at DESC LIMIT ?")
    .bind(Math.min(Math.max(limit, 1), 500))
    .all();
  return results;
}
