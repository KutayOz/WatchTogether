/**
 * The demo-request queue.
 *
 * A row here is a piece of correspondence, not an account: somebody with no
 * invite asking for one, plus the address to answer at. Approving does not
 * create anything — it mints an ordinary invitation link (see
 * routes/admin.ts), which root sends on by hand, and the applicant becomes a
 * user by redeeming it like any other invitee.
 *
 * Reviewed rows are swept 30 days after the fact by the nightly cron. The
 * decision itself is not lost with them: approve and reject both write to
 * admin_audit_log, which is append-only and never swept.
 */

/** Long enough to say why you want in, short enough not to be a payload. */
export const MAX_MESSAGE_LENGTH = 500;
export const MAX_EMAIL_LENGTH = 254;
export const MAX_NAME_LENGTH = 80;

/** How long a dealt-with request is kept before the nightly sweep drops it. */
export const REVIEWED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

/** Bounded so a flood cannot turn the admin tab into a full table scan. */
export const MAX_LISTED = 200;

export type DemoRequestStatus = "pending" | "approved" | "rejected";

export interface DemoRequestRow {
  id: string;
  email: string;
  email_lookup: string;
  display_name: string;
  message: string | null;
  status: DemoRequestStatus;
  submitted_at: number;
  reviewed_at: number | null;
  reviewed_by: string | null;
  rejection_reason: string | null;
  ip_address: string | null;
}

export interface NewDemoRequest {
  email: string;
  displayName: string;
  message?: string | null;
  ipAddress?: string | null;
}

/**
 * File a request.
 *
 * Returns "duplicate" when the address already has one waiting, which the
 * uniq_demo_open partial index enforces rather than a read-then-write — two
 * submissions racing would both find nothing and both insert. The caller
 * answers duplicates exactly as it answers a fresh filing; see the route.
 *
 * The constraint message is matched rather than swallowed wholesale, so a real
 * insert failure still surfaces as a 500 instead of being reported to the
 * applicant as a success.
 */
export async function createDemoRequest(
  db: D1Database,
  input: NewDemoRequest,
): Promise<"created" | "duplicate"> {
  const email = input.email.trim();

  try {
    await db
      .prepare(
        `INSERT INTO demo_requests
           (id, email, email_lookup, display_name, message, status, submitted_at, ip_address)
         VALUES (?1, ?2, ?3, ?4, ?5, 'pending', ?6, ?7)`,
      )
      .bind(
        crypto.randomUUID(),
        email,
        email.toLowerCase(),
        input.displayName.trim(),
        input.message?.trim() || null,
        Date.now(),
        input.ipAddress ?? null,
      )
      .run();
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      return "duplicate";
    }
    throw error;
  }

  return "created";
}

/** Newest first — the queue is read from the top and rarely scrolled. */
export async function listDemoRequests(db: D1Database, limit = MAX_LISTED) {
  const { results } = await db
    .prepare("SELECT * FROM demo_requests ORDER BY submitted_at DESC LIMIT ?")
    .bind(Math.min(Math.max(limit, 1), MAX_LISTED))
    .all<DemoRequestRow>();
  return results;
}

export async function getDemoRequest(db: D1Database, id: string): Promise<DemoRequestRow | null> {
  return db.prepare("SELECT * FROM demo_requests WHERE id = ?").bind(id).first<DemoRequestRow>();
}

/**
 * Mark a request approved.
 *
 * Allowed from `approved` as well as `pending`, because the invite link is
 * shown once and lives nowhere afterwards — root who closed the dialog too
 * early would otherwise have to go and mint an unattached link from the lobby,
 * with nothing tying it back to the request. Rejected is terminal here; the
 * WHERE clause is what enforces both.
 *
 * Returns false when the row is gone or rejected, so the caller can answer 409
 * rather than mint a link nobody asked for.
 */
export async function markApproved(
  db: D1Database,
  id: string,
  reviewerId: string,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_requests
       SET status = 'approved', reviewed_at = ?1, reviewed_by = ?2, rejection_reason = NULL
       WHERE id = ?3 AND status IN ('pending', 'approved')`,
    )
    .bind(Date.now(), reviewerId, id)
    .run();

  return result.meta.changes === 1;
}

/** Mark a request rejected. Only from `pending` — an approved link is out there. */
export async function markRejected(
  db: D1Database,
  id: string,
  reviewerId: string,
  reason?: string | null,
): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE demo_requests
       SET status = 'rejected', reviewed_at = ?1, reviewed_by = ?2, rejection_reason = ?3
       WHERE id = ?4 AND status = 'pending'`,
    )
    .bind(Date.now(), reviewerId, reason?.trim() || null, id)
    .run();

  return result.meta.changes === 1;
}

/**
 * Drop requests that were dealt with long enough ago to be history.
 *
 * D1 has no TTL indexes, so this is the nightly cron's job, same as the token
 * sweeps. Pending rows are deliberately untouched: an unread request is not
 * stale, it is unread.
 */
export async function sweepReviewedDemoRequests(db: D1Database): Promise<number> {
  const result = await db
    .prepare("DELETE FROM demo_requests WHERE reviewed_at IS NOT NULL AND reviewed_at <= ?")
    .bind(Date.now() - REVIEWED_RETENTION_MS)
    .run();

  return result.meta.changes;
}
