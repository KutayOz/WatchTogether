import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireRoot } from "../middleware/auth";
import { appendAudit, listAudit } from "../db/audit";
import {
  MAX_LISTED,
  getDemoRequest,
  listDemoRequests,
  markApproved,
  markRejected,
  type DemoRequestRow,
} from "../db/demoRequests";
import { createInvitationLink, maxLinksFor } from "../db/invitationLinks";
import { createResetToken } from "../db/passwordResets";
import { getUserById, softDeleteUser, tagOf, type UserRow } from "../db/users";

export const adminRoutes = new Hono<AppEnv>();

/** Bounded so a growing user table cannot turn a page load into a table scan. */
const MAX_USERS = 500;

interface UserSummary {
  id: string;
  username: string;
  discriminator: string;
  tag: string;
  isRootUser: boolean;
  invitedByUserId: string | null;
  createdAt: number;
  isDeleted: boolean;
}

function summarize(row: UserRow): UserSummary {
  return {
    id: row.id,
    username: row.username,
    discriminator: row.discriminator,
    tag: tagOf(row),
    isRootUser: row.is_root === 1,
    invitedByUserId: row.invited_by_user_id,
    createdAt: row.created_at,
    isDeleted: row.is_deleted === 1,
  };
}

async function allUsers(db: D1Database): Promise<UserRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY created_at LIMIT ?")
    .bind(MAX_USERS)
    .all<UserRow>();
  return results;
}

adminRoutes.get("/users", requireRoot, async (c) => {
  const rows = await allUsers(c.env.DB);
  return c.json({ users: rows.map(summarize), truncated: rows.length === MAX_USERS });
});

/**
 * The invite tree.
 *
 * Built by bucketing children by parent in one pass, then walking down from the
 * root — linear, where the .NET version rescanned the full user list once per
 * node. Iterative rather than recursive so a cycle in the data (which the
 * schema permits, since invited_by is just a nullable self-reference) cannot
 * blow the stack.
 */
adminRoutes.get("/user-tree", requireRoot, async (c) => {
  const rows = await allUsers(c.env.DB);

  const childrenByParent = new Map<string | null, UserRow[]>();
  for (const row of rows) {
    const parent = row.invited_by_user_id;
    const bucket = childrenByParent.get(parent);
    if (bucket) bucket.push(row);
    else childrenByParent.set(parent, [row]);
  }

  interface TreeNode extends UserSummary {
    children: TreeNode[];
  }

  const root = rows.find((row) => row.is_root === 1);
  if (!root) return c.json({ root: null, totalUsers: rows.length });

  const visited = new Set<string>();
  const build = (row: UserRow): TreeNode => {
    visited.add(row.id);
    const children = (childrenByParent.get(row.id) ?? [])
      .filter((child) => !visited.has(child.id))
      .map(build);
    return { ...summarize(row), children };
  };

  const tree = build(root);

  // Anyone whose inviter is missing (deleted, or never set) would otherwise
  // vanish from the tree entirely.
  const orphans = rows.filter((row) => !visited.has(row.id)).map(summarize);

  return c.json({ root: tree, orphans, totalUsers: rows.length });
});

adminRoutes.get("/audit-log", requireRoot, async (c) => {
  const limit = Number(c.req.query("limit") ?? 100);
  return c.json({ entries: await listAudit(c.env.DB, Number.isFinite(limit) ? limit : 100) });
});

/**
 * Mint a password reset link for a user.
 *
 * The only recovery path there is. No email address exists anywhere in this
 * schema, so a forgotten password cannot be self-served — root generates a
 * single-use link here and hands it over out of band. Redeeming it also works
 * on an account that has never had a password, which is how a passkey-only user
 * gets one.
 *
 * The raw token exists only in this response; the database keeps its SHA-256.
 * Reissuing invalidates any link still outstanding for that user.
 */
adminRoutes.post("/users/:id/password/reset", requireRoot, async (c) => {
  const actor = c.get("user");
  const targetId = c.req.param("id");

  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ message: "User not found." }, 404);

  const { token, expiresAt } = await createResetToken(c.env.DB, targetId, actor.id);

  await appendAudit(c.env.DB, {
    actorUserId: actor.id,
    actorTag: tagOf(actor),
    action: "PasswordResetLinkIssued",
    targetType: "User",
    targetId,
    details: `Issued a password reset link for ${tagOf(target)}`,
    ipAddress: c.req.header("CF-Connecting-IP") ?? undefined,
  });

  return c.json({ resetUrl: `${c.env.RP_ORIGIN}/reset/${token}`, expiresAt });
});

adminRoutes.delete("/users/:id", requireRoot, async (c) => {
  const actor = c.get("user");
  const targetId = c.req.param("id");

  const target = await getUserById(c.env.DB, targetId);
  if (!target) return c.json({ message: "User not found." }, 404);
  if (target.is_root === 1) return c.json({ message: "The root user cannot be deleted." }, 400);
  if (target.id === actor.id) return c.json({ message: "You cannot delete yourself." }, 400);

  // Also clears their passkeys and frees the username — see softDeleteUser.
  await softDeleteUser(c.env.DB, targetId, actor.id);

  await appendAudit(c.env.DB, {
    actorUserId: actor.id,
    actorTag: tagOf(actor),
    action: "DeleteUser",
    targetType: "User",
    targetId,
    details: `Deleted ${tagOf(target)}`,
    ipAddress: c.req.header("CF-Connecting-IP") ?? undefined,
  });

  return c.json({ message: "User deleted." });
});

// ────────────────── Demo requests ──────────────────
//
// The queue of people asking for an invite without holding one. Reviewing is
// root's alone, like everything else in this file, and approval produces a
// link rather than a message: nothing in this app can send mail, so root copies
// the link and passes it on however they already talk to the applicant. Same
// arrangement as the password reset above.

/** A rejection note is for root's own memory — nothing shows it to the applicant. */
const MAX_REJECTION_REASON = 500;

interface DemoRequestSummary {
  id: string;
  email: string;
  displayName: string;
  message: string | null;
  status: string;
  submittedAt: number;
  reviewedAt: number | null;
  reviewedByUserId: string | null;
  rejectionReason: string | null;
}

function summarizeRequest(row: DemoRequestRow): DemoRequestSummary {
  return {
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    message: row.message,
    status: row.status,
    submittedAt: row.submitted_at,
    reviewedAt: row.reviewed_at,
    reviewedByUserId: row.reviewed_by,
    rejectionReason: row.rejection_reason,
  };
}

adminRoutes.get("/demo-requests", requireRoot, async (c) => {
  const rows = await listDemoRequests(c.env.DB);
  return c.json({ requests: rows.map(summarizeRequest), truncated: rows.length === MAX_LISTED });
});

/**
 * Approve a request and mint the invite that answers it.
 *
 * The status moves first and the link is minted second, so the two failure
 * orders both land somewhere recoverable: a link that fails to mint leaves an
 * approved row root can approve again (markApproved accepts `approved` for
 * exactly this reason), whereas minting first would hand out a live invite for
 * a request that a concurrent reject had just closed.
 *
 * The invite is an ordinary one, attributed to root, and inherits everything
 * that comes with that: single use, 48 hours, and the invitee appears under
 * root in the user tree. The raw token is in this response and nowhere else.
 */
adminRoutes.post("/demo-requests/:id/approve", requireRoot, async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");

  const request = await getDemoRequest(c.env.DB, id);
  if (!request) return c.json({ message: "Request not found." }, 404);
  if (request.status === "rejected") {
    return c.json(
      { message: "That request was rejected. Invite them from the lobby instead." },
      409,
    );
  }

  if (!(await markApproved(c.env.DB, id, actor.id))) {
    // Somebody else moved it between the read and the write.
    return c.json({ message: "That request was just changed. Reload and try again." }, 409);
  }

  const link = await createInvitationLink(c.env.DB, actor.id, maxLinksFor(actor.is_root === 1));
  if (!link.ok) {
    return c.json(
      { message: "You have no invite slots left. Revoke your active link first." },
      400,
    );
  }

  await appendAudit(c.env.DB, {
    actorUserId: actor.id,
    actorTag: tagOf(actor),
    action: "DemoRequestApproved",
    targetType: "DemoRequest",
    targetId: id,
    details: `Approved ${request.display_name} <${request.email}> and minted an invite link`,
    ipAddress: c.req.header("CF-Connecting-IP") ?? undefined,
  });

  return c.json({
    message: "Approved. The link below is the only copy.",
    inviteUrl: `${c.env.RP_ORIGIN}/invite/${link.token}`,
    expiresAt: link.expiresAt,
  });
});

/** Close a request without minting anything. Terminal — see markRejected. */
adminRoutes.post("/demo-requests/:id/reject", requireRoot, async (c) => {
  const actor = c.get("user");
  const id = c.req.param("id");

  const body = await c.req
    .json<{ reason?: unknown }>()
    // A bodiless POST is the normal case — rejecting without a note.
    .catch(() => ({}) as { reason?: unknown });
  const reason = typeof body.reason === "string" ? body.reason.trim() : "";
  if (reason.length > MAX_REJECTION_REASON) {
    return c.json({ message: `Keep the note under ${MAX_REJECTION_REASON} characters.` }, 400);
  }

  const request = await getDemoRequest(c.env.DB, id);
  if (!request) return c.json({ message: "Request not found." }, 404);

  if (!(await markRejected(c.env.DB, id, actor.id, reason))) {
    return c.json({ message: "That request has already been dealt with." }, 409);
  }

  await appendAudit(c.env.DB, {
    actorUserId: actor.id,
    actorTag: tagOf(actor),
    action: "DemoRequestRejected",
    targetType: "DemoRequest",
    targetId: id,
    details: `Rejected ${request.display_name} <${request.email}>${reason ? `: ${reason}` : ""}`,
    ipAddress: c.req.header("CF-Connecting-IP") ?? undefined,
  });

  return c.json({ message: "Request closed." });
});
