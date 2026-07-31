import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import {
  createInvitationLink,
  findLinkByToken,
  getActiveLink,
  linkValidity,
  maxLinksFor,
  revokeActiveLink,
} from "../db/invitationLinks";
import { getUserById, tagOf } from "../db/users";

export const invitationRoutes = new Hono<AppEnv>();

invitationRoutes.get("/available-slots", requireAuth, async (c) => {
  const user = c.get("user");
  const max = maxLinksFor(user.is_root === 1);

  return c.json({
    maxSlots: user.is_root === 1 ? null : max,
    usedSlots: user.active_link_count,
    remainingSlots: user.is_root === 1 ? null : Math.max(0, max - user.active_link_count),
    isUnlimited: user.is_root === 1,
  });
});

/**
 * Mint a shareable signup link.
 *
 * The raw token exists only in this response — the database stores its hash.
 * Losing it means revoking and minting again, which is the intended tradeoff.
 */
invitationRoutes.post("/generate-link", requireAuth, async (c) => {
  const user = c.get("user");

  const result = await createInvitationLink(
    c.env.DB,
    user.id,
    maxLinksFor(user.is_root === 1),
  );

  if (!result.ok) {
    return c.json(
      { success: false, message: "You have no invite slots left. Revoke your active link first." },
      400,
    );
  }

  return c.json({
    success: true,
    inviteUrl: `${c.env.RP_ORIGIN}/invite/${result.token}`,
    expiresAt: result.expiresAt,
  });
});

/** Anonymous: the signup screen calls this before the user has an account. */
invitationRoutes.get("/validate/:token", async (c) => {
  const link = await findLinkByToken(c.env.DB, c.req.param("token"));
  const validity = linkValidity(link);

  if (validity !== "valid" || !link) {
    const message =
      validity === "used"
        ? "That invite has already been used."
        : validity === "expired"
          ? "That invite has expired."
          : "That invite is not valid.";
    return c.json({ valid: false, message });
  }

  const inviter = await getUserById(c.env.DB, link.inviter_user_id);

  return c.json({
    valid: true,
    inviterTag: inviter ? tagOf(inviter) : null,
  });
});

/**
 * Report whether a link is outstanding, without revealing it.
 *
 * The URL is deliberately absent: the token is unrecoverable once minted, so
 * there is nothing to return but its existence and expiry.
 */
invitationRoutes.get("/active-link", requireAuth, async (c) => {
  const link = await getActiveLink(c.env.DB, c.get("user").id);

  return c.json({
    hasActiveLink: link !== null,
    expiresAt: link?.expires_at ?? null,
  });
});

invitationRoutes.delete("/revoke-link", requireAuth, async (c) => {
  const revoked = await revokeActiveLink(c.env.DB, c.get("user").id);

  return revoked
    ? c.json({ message: "Invite link revoked." })
    : c.json({ message: "You have no active invite link." }, 404);
});
