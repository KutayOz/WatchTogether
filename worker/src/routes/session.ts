import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { getIceServers } from "../lib/ice";
import { buildInviteToken, newSessionId, parseInviteToken } from "../lib/sessionId";

export const sessionRoutes = new Hono<AppEnv>();

const roomFor = (env: Env, sessionId: string) =>
  env.SESSION.get(env.SESSION.idFromName(sessionId));

interface RoomState {
  exists: boolean;
  participantCount: number;
  creatorUserId?: string;
}

sessionRoutes.post("/create", requireAuth, async (c) => {
  const sessionId = newSessionId();

  await roomFor(c.env, sessionId).fetch("https://do/create", {
    method: "POST",
    body: JSON.stringify({ creatorUserId: c.get("user").id }),
  });

  return c.json({ sessionId });
});

sessionRoutes.get("/:sessionId/validate", requireAuth, async (c) => {
  const response = await roomFor(c.env, c.req.param("sessionId")).fetch("https://do/state");
  const state = await response.json<RoomState>();

  return c.json({
    exists: state.exists,
    // A full session is real but unjoinable; the client distinguishes them.
    valid: state.exists && state.participantCount < 2,
    participantCount: state.participantCount,
  });
});

sessionRoutes.get("/ice-servers", requireAuth, async (c) => {
  return c.json({ iceServers: await getIceServers(c.env) });
});

/** Mint a single-use invite. Creator only, enforced inside the Durable Object. */
sessionRoutes.post("/:sessionId/invite", requireAuth, async (c) => {
  const sessionId = c.req.param("sessionId");

  const response = await roomFor(c.env, sessionId).fetch("https://do/invite", {
    method: "POST",
    body: JSON.stringify({ userId: c.get("user").id }),
  });

  if (response.status === 403) return c.json({ message: "Not your session." }, 403);
  if (!response.ok) return c.json({ message: "Session not found." }, 404);

  const body = await response.json<{ secret: string; expiresAt: number }>();
  const token = buildInviteToken(sessionId, body.secret);

  return c.json({
    success: true,
    inviteUrl: `${c.env.RP_ORIGIN}/join/${token}`,
    expiresAt: body.expiresAt,
  });
});

/**
 * Inspect an invite without spending it, so the join screen can show who is
 * inviting before the user commits.
 */
sessionRoutes.get("/invite/:token/validate", requireAuth, async (c) => {
  const parsed = parseInviteToken(c.req.param("token"));
  if (!parsed) return c.json({ valid: false, message: "That invite is not valid." });

  const response = await roomFor(c.env, parsed.sessionId).fetch("https://do/state");
  const state = await response.json<RoomState>();

  if (!state.exists) return c.json({ valid: false, message: "That session has ended." });

  return c.json({ valid: true, sessionId: parsed.sessionId });
});

sessionRoutes.post("/invite/:token/join", requireAuth, async (c) => {
  const parsed = parseInviteToken(c.req.param("token"));
  if (!parsed) return c.json({ success: false, message: "That invite is not valid." }, 400);

  const response = await roomFor(c.env, parsed.sessionId).fetch("https://do/invite/redeem", {
    method: "POST",
    body: JSON.stringify({ secret: parsed.secret, userId: c.get("user").id }),
  });

  const body = await response.json<{ ok: boolean; error?: string }>();
  if (!body.ok) {
    const message =
      body.error === "already_used"
        ? "That invite has already been used."
        : body.error === "expired"
          ? "That invite has expired."
          : "That invite is not valid.";
    return c.json({ success: false, message }, 400);
  }

  return c.json({ success: true, sessionId: parsed.sessionId });
});

/**
 * The signalling socket.
 *
 * Authentication happens here, in the Worker, before the Durable Object is
 * touched — an unauthenticated flood then costs one Worker request instead of
 * spinning up an object per connection. The verified identity is passed on as
 * internal headers, which are safe because the Durable Object is not
 * addressable from outside this Worker.
 */
sessionRoutes.get("/ws/:sessionId", async (c) => {
  if (c.req.header("Upgrade") !== "websocket") {
    return c.json({ message: "Expected a WebSocket upgrade." }, 426);
  }

  const user = c.get("user");
  if (!user) return c.json({ message: "Unauthorized" }, 401);

  return roomFor(c.env, c.req.param("sessionId")).fetch("https://do/ws", {
    headers: {
      Upgrade: "websocket",
      "X-WT-User-Id": user.id,
      "X-WT-Username": user.username,
    },
  });
});
