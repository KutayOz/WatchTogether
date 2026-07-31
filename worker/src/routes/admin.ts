import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireRoot } from "../middleware/auth";
import { appendAudit, listAudit } from "../db/audit";
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
