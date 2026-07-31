import { randomToken, sha256Hex } from "../lib/crypto";
import { releaseInviteSlot, tryReserveInviteSlot } from "./users";

/** InvitationLinkService.cs:15. The XML comment on the entity claiming 15 minutes was stale. */
export const LINK_TTL_MS = 48 * 60 * 60 * 1000;

/** InvitationService.cs:32-33 — root invites without limit, everyone else gets one. */
export const ROOT_MAX_LINKS = Number.MAX_SAFE_INTEGER;
export const REGULAR_MAX_LINKS = 1;

export interface InvitationLinkRow {
  id: string;
  token_lookup: string;
  inviter_user_id: string;
  created_at: number;
  expires_at: number;
  used_at: number | null;
  used_by_user_id: string | null;
  ticket_returned: number;
}

/**
 * Mint a shareable invite link.
 *
 * The raw token is returned once and never stored — only its SHA-256. The
 * .NET version additionally BCrypt-hashed it, which protected nothing: the
 * token already carries 256 bits of entropy, so there is no guessing attack
 * for a cost factor to slow down. It just cost ~400ms of CPU per validation,
 * which this platform does not have.
 */
export async function createInvitationLink(
  db: D1Database,
  inviterUserId: string,
  maxLinks: number,
): Promise<{ ok: true; token: string; expiresAt: number } | { ok: false; error: "no_slots" }> {
  if (!(await tryReserveInviteSlot(db, inviterUserId, maxLinks))) {
    return { ok: false, error: "no_slots" };
  }

  const token = randomToken(32);
  const expiresAt = Date.now() + LINK_TTL_MS;

  try {
    await db
      .prepare(
        `INSERT INTO invitation_links (id, token_lookup, inviter_user_id, created_at, expires_at)
         VALUES (?1, ?2, ?3, ?4, ?5)`,
      )
      .bind(crypto.randomUUID(), await sha256Hex(token), inviterUserId, Date.now(), expiresAt)
      .run();
  } catch (error) {
    // Give the slot back rather than leaking quota on a failed insert.
    await releaseInviteSlot(db, inviterUserId);
    throw error;
  }

  return { ok: true, token, expiresAt };
}

/** Look up a link by raw token. Indexed point query on the hash. */
export async function findLinkByToken(
  db: D1Database,
  token: string,
): Promise<InvitationLinkRow | null> {
  return db
    .prepare("SELECT * FROM invitation_links WHERE token_lookup = ?")
    .bind(await sha256Hex(token))
    .first<InvitationLinkRow>();
}

export type LinkValidity = "valid" | "not_found" | "expired" | "used";

export function linkValidity(link: InvitationLinkRow | null): LinkValidity {
  if (!link) return "not_found";
  if (link.used_at !== null) return "used";
  if (link.expires_at <= Date.now() || link.ticket_returned === 1) return "expired";
  return "valid";
}

/**
 * Claim a link, atomically.
 *
 * Every precondition lives in the UPDATE's WHERE clause, so two concurrent
 * redemptions cannot both observe an unused link and both succeed. The .NET
 * equivalent read the document, mutated it, and wrote it back with no
 * compare-and-swap, so its single-use guarantee was advisory.
 *
 * Only `used_at` is set here. The redeemer is recorded separately by
 * setLinkRedeemer once that user exists — claiming has to happen *before* the
 * account is created (so a crash cannot hand out a second one), but
 * `used_by_user_id` is a foreign key into users and cannot reference a row
 * that is not there yet.
 *
 * Returns false when the link was already spent or has expired.
 */
export async function burnLink(db: D1Database, token: string): Promise<boolean> {
  const result = await db
    .prepare(
      `UPDATE invitation_links
       SET used_at = ?1
       WHERE token_lookup = ?2
         AND used_at IS NULL
         AND ticket_returned = 0
         AND expires_at > ?1`,
    )
    .bind(Date.now(), await sha256Hex(token))
    .run();

  return result.meta.changes === 1;
}

/** Record who redeemed a claimed link, once their account exists. */
export async function setLinkRedeemer(
  db: D1Database,
  token: string,
  usedByUserId: string,
): Promise<void> {
  await db
    .prepare("UPDATE invitation_links SET used_by_user_id = ? WHERE token_lookup = ?")
    .bind(usedByUserId, await sha256Hex(token))
    .run();
}

/**
 * Undo a burn.
 *
 * D1 has no interactive transactions, so registration burns the invite before
 * inserting the user. If that insert then fails, this puts the invite back
 * rather than stranding the invitee with a spent link and no account.
 */
export async function unburnLink(db: D1Database, token: string): Promise<void> {
  await db
    .prepare(
      `UPDATE invitation_links SET used_at = NULL, used_by_user_id = NULL
       WHERE token_lookup = ?`,
    )
    .bind(await sha256Hex(token))
    .run();
}

export async function getActiveLink(
  db: D1Database,
  inviterUserId: string,
): Promise<InvitationLinkRow | null> {
  return db
    .prepare(
      `SELECT * FROM invitation_links
       WHERE inviter_user_id = ? AND used_at IS NULL AND ticket_returned = 0 AND expires_at > ?
       ORDER BY created_at DESC LIMIT 1`,
    )
    .bind(inviterUserId, Date.now())
    .first<InvitationLinkRow>();
}

/** Revoke an outstanding link and hand the slot back. */
export async function revokeActiveLink(db: D1Database, inviterUserId: string): Promise<boolean> {
  const result = await db
    .prepare(
      `DELETE FROM invitation_links
       WHERE inviter_user_id = ? AND used_at IS NULL AND ticket_returned = 0`,
    )
    .bind(inviterUserId)
    .run();

  if (result.meta.changes === 0) return false;

  for (let i = 0; i < result.meta.changes; i++) await releaseInviteSlot(db, inviterUserId);
  return true;
}

/**
 * Reclaim slots held by expired links.
 *
 * Mongo expired these with a TTL index; D1 has none, so the nightly cron calls
 * this. Marking rather than deleting keeps the audit trail of who invited whom.
 */
export async function returnExpiredTickets(db: D1Database): Promise<number> {
  const { results } = await db
    .prepare(
      `SELECT inviter_user_id FROM invitation_links
       WHERE used_at IS NULL AND ticket_returned = 0 AND expires_at <= ?`,
    )
    .bind(Date.now())
    .all<{ inviter_user_id: string }>();

  if (results.length === 0) return 0;

  await db
    .prepare(
      `UPDATE invitation_links SET ticket_returned = 1
       WHERE used_at IS NULL AND ticket_returned = 0 AND expires_at <= ?`,
    )
    .bind(Date.now())
    .run();

  for (const row of results) await releaseInviteSlot(db, row.inviter_user_id);
  return results.length;
}

export function maxLinksFor(isRoot: boolean): number {
  return isRoot ? ROOT_MAX_LINKS : REGULAR_MAX_LINKS;
}
