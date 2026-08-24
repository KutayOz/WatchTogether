// Env is declared globally by the generated worker-configuration.d.ts.
import {
  CLOSE_PAYLOAD_TOO_LARGE,
  CLOSE_RATE_LIMITED,
  CLOSE_REPLACED,
  CLOSE_SESSION_FULL,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
  MAX_FRAME_BYTES,
  MAX_PARTICIPANTS,
  decodeClientMessage,
  encode,
  type ClientMessage,
  type ServerMessage,
} from "../lib/protocol";
import { sha256Hex, randomToken } from "../lib/crypto";

/** SessionService.cs:22 — how long an emptied session survives before removal. */
const GRACE_PERIOD_MS = 5 * 60 * 1000;
/** SessionService.cs:23 — session-invite lifetime. */
const INVITE_TTL_MS = 15 * 60 * 1000;

/** Per-socket flood ceiling. Signalling bursts at join; steady state is far below. */
const RATE_LIMIT_MESSAGES = 60;
const RATE_LIMIT_WINDOW_MS = 10_000;

interface SessionMeta {
  creatorUserId: string;
  createdAt: number;
  /** When the room last became empty; null while occupied. Drives the grace alarm. */
  emptySince: number | null;
  inviteHash: string | null;
  inviteExpiresAt: number | null;
  inviteUsedBy: string | null;
}

interface Attachment {
  userId: string;
  username: string;
  joinedAt: number;
  /**
   * Screen-share stream id this socket last declared, or null.
   *
   * Lives in the attachment rather than a field on this class because a field
   * would not survive hibernation, and hibernation is exactly when a long
   * screen share is running: the room sleeps through a settled call and would
   * wake up having forgotten who was sharing. The client declares, the room
   * records, and every joiner is told — see the ExistingPeer send below.
   */
  sharing: string | null;
}

interface RateBucket {
  tokens: number;
  refilledAt: number;
}

/**
 * One instance per session, addressed by `env.SESSION.idFromName(sessionId)`.
 *
 * Replaces both the ConcurrentDictionary in SessionService and the SignalR
 * group registry. Those were two separate structures that could disagree —
 * a participant could be added to one and missing from the other. Here there
 * is one authoritative set, and the runtime serialises every access to it, so
 * the lock(session) blocks and the Interlocked single-use burn are not needed.
 */
export class SessionRoom {
  /**
   * In-memory, deliberately. Hibernation discards it, which just grants a
   * reconnecting client a fresh allowance — acceptable for a flood guard, and
   * it keeps the hot path off storage.
   */
  private readonly buckets = new WeakMap<WebSocket, RateBucket>();

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {
    // Answered by the runtime without waking or billing this object. Without
    // it, a keepalive every 30s on an idle call would cost more Durable Object
    // requests than the actual conversation.
    this.state.setWebSocketAutoResponse(new WebSocketRequestResponsePair("ping", "pong"));
  }

  // -------------------------------------------------------------------------
  // HTTP surface (called only by the Worker, never directly by a browser)
  // -------------------------------------------------------------------------

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    switch (url.pathname) {
      case "/create":
        return this.handleCreate(request);
      case "/state":
        return this.handleState();
      case "/invite":
        return this.handleMintInvite(request);
      case "/invite/redeem":
        return this.handleRedeemInvite(request);
      case "/ws":
        return this.handleUpgrade(request);
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async handleCreate(request: Request): Promise<Response> {
    const { creatorUserId } = await request.json<{ creatorUserId: string }>();

    const existing = await this.getMeta();
    if (existing) return Response.json({ created: false });

    await this.putMeta({
      creatorUserId,
      createdAt: Date.now(),
      // Born empty: the creator is not a participant until they open a socket,
      // so the grace clock starts now and reaps the session if they never do.
      emptySince: Date.now(),
      inviteHash: null,
      inviteExpiresAt: null,
      inviteUsedBy: null,
    });
    await this.scheduleAlarm();

    return Response.json({ created: true });
  }

  private async handleState(): Promise<Response> {
    const meta = await this.getMeta();
    if (!meta) return Response.json({ exists: false, participantCount: 0 });

    return Response.json({
      exists: true,
      participantCount: this.participants().size,
      creatorUserId: meta.creatorUserId,
    });
  }

  /**
   * Mint a single-use invite for this session.
   *
   * The token embeds the session id so the Worker can route `/join/:token`
   * straight to the owning object without a lookup table. That the id is
   * recoverable from the token is harmless — the token grants access to that
   * session regardless.
   */
  private async handleMintInvite(request: Request): Promise<Response> {
    const { userId } = await request.json<{ userId: string }>();

    const meta = await this.getMeta();
    if (!meta) return Response.json({ ok: false, error: "not_found" }, { status: 404 });
    if (meta.creatorUserId !== userId) {
      return Response.json({ ok: false, error: "forbidden" }, { status: 403 });
    }

    const secret = randomToken(32);
    meta.inviteHash = await sha256Hex(secret);
    meta.inviteExpiresAt = Date.now() + INVITE_TTL_MS;
    meta.inviteUsedBy = null;

    await this.putMeta(meta);
    await this.scheduleAlarm();

    return Response.json({ ok: true, secret, expiresAt: meta.inviteExpiresAt });
  }

  /**
   * Validate and burn an invite.
   *
   * Read, check and write happen in one uninterrupted invocation, so the
   * compare-and-swap that guarded this in .NET is redundant — the runtime will
   * not interleave a second redemption between the check and the write.
   */
  private async handleRedeemInvite(request: Request): Promise<Response> {
    const { secret, userId } = await request.json<{ secret: string; userId: string }>();

    const meta = await this.getMeta();
    if (!meta || !meta.inviteHash || meta.inviteExpiresAt === null) {
      return Response.json({ ok: false, error: "invalid" });
    }
    if (meta.inviteUsedBy !== null) return Response.json({ ok: false, error: "already_used" });
    if (meta.inviteExpiresAt <= Date.now()) return Response.json({ ok: false, error: "expired" });
    if ((await sha256Hex(secret)) !== meta.inviteHash) {
      return Response.json({ ok: false, error: "invalid" });
    }

    meta.inviteUsedBy = userId;
    await this.putMeta(meta);

    return Response.json({ ok: true, creatorUserId: meta.creatorUserId });
  }

  // -------------------------------------------------------------------------
  // Join
  // -------------------------------------------------------------------------

  /**
   * The upgrade IS the join.
   *
   * SignalR needed a separate JoinSession invoke after connecting, and nothing
   * re-issued it after an automatic reconnect — so a reconnected client held a
   * live transport while sitting outside the group, receiving nothing. Binding
   * membership to the socket's existence removes the failure mode rather than
   * papering over it.
   */
  private async handleUpgrade(request: Request): Promise<Response> {
    const userId = request.headers.get("X-WT-User-Id");
    const username = request.headers.get("X-WT-Username");

    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];

    if (!userId || !username) {
      // Accept then close: a browser cannot read a body from a rejected
      // upgrade, so a close code is the only channel for the reason.
      this.state.acceptWebSocket(server);
      server.close(CLOSE_UNAUTHORIZED, "unauthorized");
      return new Response(null, { status: 101, webSocket: client });
    }

    const meta = await this.getMeta();
    if (!meta) {
      this.state.acceptWebSocket(server);
      server.close(CLOSE_SESSION_NOT_FOUND, "session_not_found");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Capacity counts distinct *other* users, not sockets. Counting sockets
    // would let a user's own stale connection lock them out of their own
    // session, and would let two tabs fill a two-person room. Rejoining costs
    // nothing because the joiner is excluded from the tally.
    const others = [...this.participants().keys()].filter((id) => id !== userId);
    if (others.length >= MAX_PARTICIPANTS) {
      this.state.acceptWebSocket(server);
      server.close(CLOSE_SESSION_FULL, "session_full");
      return new Response(null, { status: 101, webSocket: client });
    }

    // Evict this user's previous sockets. A client that dropped without a
    // clean close leaves a ghost whose webSocketClose has not fired yet;
    // without this, its own reconnect would be refused as a duplicate.
    const stale = this.state.getWebSockets(userId);
    const isReconnect = stale.length > 0;
    for (const socket of stale) {
      try {
        socket.close(CLOSE_REPLACED, "replaced");
      } catch {
        // Already closing; the runtime will clean it up.
      }
    }

    // The tag is what makes getWebSockets(userId) work above, and it survives
    // hibernation.
    this.state.acceptWebSocket(server, [userId]);
    server.serializeAttachment({
      userId,
      username,
      joinedAt: Date.now(),
      // A fresh socket has declared nothing yet. The client re-declares right
      // after Joined, so a reconnecting sharer fills this back in immediately.
      sharing: null,
    } satisfies Attachment);

    if (meta.emptySince !== null) {
      meta.emptySince = null;
      await this.putMeta(meta);
      await this.scheduleAlarm();
    }

    // Ordering is load-bearing and mirrors WatchTogetherHub.cs:82-91:
    // announce to the room first, then tell the newcomer who was already here,
    // then release them with Joined.
    this.broadcastExcept(server, {
      t: isReconnect ? "PeerReconnected" : "PeerJoined",
      d: { name: username },
    });

    for (const [otherId, attachment] of this.participants()) {
      if (otherId === userId) continue;
      server.send(
        encode({
          t: "ExistingPeer",
          // ?? null rather than a bare read: a socket accepted before this
          // field existed deserializes without it, and undefined would reach
          // the client as a missing key rather than an honest "not sharing".
          d: { name: attachment.username, sharing: attachment.sharing ?? null },
        }),
      );
    }

    server.send(
      encode({
        t: "Joined",
        d: {
          you: { userId, username },
          // The creator offers. Previously this came from router state on the
          // client, so a refresh mid-call left both peers waiting to receive
          // an offer neither would send.
          isOfferer: meta.creatorUserId === userId,
          capacity: MAX_PARTICIPANTS,
        },
      }),
    );

    return new Response(null, { status: 101, webSocket: client });
  }

  // -------------------------------------------------------------------------
  // WebSocket hibernation handlers
  // -------------------------------------------------------------------------

  async webSocketMessage(ws: WebSocket, raw: string | ArrayBuffer): Promise<void> {
    if (typeof raw !== "string") return;

    // Checked before parsing: rejecting an oversized frame must not cost the
    // CPU of parsing it.
    if (raw.length > MAX_FRAME_BYTES) {
      ws.close(CLOSE_PAYLOAD_TOO_LARGE, "payload_too_large");
      return;
    }

    if (!this.consumeToken(ws)) {
      ws.close(CLOSE_RATE_LIMITED, "rate_limited");
      return;
    }

    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    const message = decodeClientMessage(raw);
    // Dropped, but no longer in silence. The payload the decoder actually
    // refuses in practice is an SDP over MAX_SDP_LENGTH, and a renegotiation
    // offer vanishing without a word is indistinguishable from one that was
    // delivered and ignored: the sharer believes it renegotiated, the viewer
    // keeps decoding a track that is no longer being sent, and the picture
    // freezes on a connection that reports itself healthy. The error frame does
    // not repair that, but it puts the reason in the sender's own console.
    // Cheap to emit and already bounded by the token bucket above.
    if (!message) {
      ws.send(
        encode({
          t: "Error",
          d: { code: 400, message: "Frame rejected: malformed, blank, or over a field limit." },
        }),
      );
      return;
    }

    await this.route(ws, attachment, message);
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    await this.handleDeparture(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    await this.handleDeparture(ws);
  }

  private async route(
    ws: WebSocket,
    self: Attachment,
    message: ClientMessage,
  ): Promise<void> {
    switch (message.t) {
      case "offer":
        return this.broadcastExcept(ws, {
          t: "ReceiveOffer",
          d: { sdp: message.d.sdp, name: self.username },
        });
      case "answer":
        return this.broadcastExcept(ws, { t: "ReceiveAnswer", d: { sdp: message.d.sdp } });
      case "ice":
        return this.broadcastExcept(ws, { t: "ReceiveIceCandidate", d: { c: message.d.c } });
      case "reoffer":
        return this.broadcastExcept(ws, {
          t: "ReceiveRenegotiationOffer",
          d: { sdp: message.d.sdp },
        });
      case "reanswer":
        return this.broadcastExcept(ws, {
          t: "ReceiveRenegotiationAnswer",
          d: { sdp: message.d.sdp },
        });

      case "chat":
        // THE ONE THAT ECHOES. The client does not append its own messages
        // locally — they arrive only through this broadcast. Narrowing it to
        // "others" makes your own chat appear empty to you.
        return this.broadcastAll({
          t: "ReceiveChatMessage",
          d: {
            sender: self.username,
            message: message.d.m,
            timestamp: new Date().toISOString(),
          },
        });

      case "media":
        return this.broadcastExcept(ws, {
          t: "PeerMediaStateChanged",
          d: { name: self.username, state: message.d },
        });
      case "ss:req":
        return this.broadcastExcept(ws, {
          t: "ScreenShareRequested",
          d: { name: self.username },
        });
      case "ss:res":
        return this.broadcastExcept(ws, {
          t: "ScreenShareResponse",
          d: { approved: message.d.approved, name: self.username },
        });
      // ss:start and ss:stop are the two frames the room does not merely relay:
      // it records them, so a peer who joins or rejoins later can be told the
      // truth instead of inferring it from frames that may never have arrived.
      case "ss:start":
        ws.serializeAttachment({ ...self, sharing: message.d.streamId } satisfies Attachment);
        return this.broadcastExcept(ws, {
          t: "ScreenShareStarted",
          d: { name: self.username, streamId: message.d.streamId },
        });
      case "ss:stop":
        ws.serializeAttachment({ ...self, sharing: null } satisfies Attachment);
        return this.broadcastExcept(ws, {
          t: "ScreenShareStopped",
          d: { name: self.username },
        });

      case "leave":
        ws.close(1000, "left");
        return this.handleDeparture(ws);
    }
  }

  private async handleDeparture(ws: WebSocket): Promise<void> {
    const attachment = ws.deserializeAttachment() as Attachment | null;
    if (!attachment) return;

    // Whether the user is really gone or merely replaced a socket: if any
    // other socket still carries this tag, they are still here.
    const remaining = this.state
      .getWebSockets(attachment.userId)
      .filter((socket) => socket !== ws && socket.readyState === WebSocket.READY_STATE_OPEN);
    if (remaining.length > 0) return;

    this.broadcastExcept(ws, { t: "PeerLeft", d: { name: attachment.username } });

    if (this.participants().size === 0) {
      const meta = await this.getMeta();
      if (meta && meta.emptySince === null) {
        meta.emptySince = Date.now();
        await this.putMeta(meta);
        await this.scheduleAlarm();
      }
    }
  }

  // -------------------------------------------------------------------------
  // Alarms
  // -------------------------------------------------------------------------

  /**
   * A Durable Object has exactly one alarm, so the grace deadline and the
   * invite expiry share it: always arm the earlier, and re-arm after firing.
   */
  private async scheduleAlarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    const deadlines: number[] = [];
    if (meta.emptySince !== null) deadlines.push(meta.emptySince + GRACE_PERIOD_MS);
    if (meta.inviteExpiresAt !== null && meta.inviteUsedBy === null) {
      deadlines.push(meta.inviteExpiresAt);
    }

    if (deadlines.length === 0) {
      await this.state.storage.deleteAlarm();
      return;
    }
    await this.state.storage.setAlarm(Math.min(...deadlines));
  }

  async alarm(): Promise<void> {
    const meta = await this.getMeta();
    if (!meta) return;

    const now = Date.now();

    if (meta.inviteExpiresAt !== null && meta.inviteExpiresAt <= now) {
      meta.inviteHash = null;
      meta.inviteExpiresAt = null;
    }

    // Re-check occupancy rather than trusting the timestamp: someone may have
    // rejoined between the alarm being armed and it firing.
    if (
      meta.emptySince !== null &&
      meta.emptySince + GRACE_PERIOD_MS <= now &&
      this.participants().size === 0
    ) {
      // Session existence is storage existence. Dropping everything is the
      // deletion — no registry to update, no tombstone to reap.
      await this.state.storage.deleteAll();
      return;
    }

    await this.putMeta(meta);
    await this.scheduleAlarm();
  }

  // -------------------------------------------------------------------------
  // Internals
  // -------------------------------------------------------------------------

  /**
   * Live participants, derived from open sockets rather than stored.
   *
   * Nothing to keep in sync, so the room's membership cannot drift from the
   * set of connections the way SessionService's list could drift from
   * SignalR's group registry. Multiple sockets for one user collapse to one
   * entry.
   */
  private participants(): Map<string, Attachment> {
    const map = new Map<string, Attachment>();
    for (const ws of this.state.getWebSockets()) {
      // Live sockets only. getWebSockets keeps handing back a socket that has
      // been closed until the runtime reaps it, and because this map is keyed by
      // user, a lingering ghost could shadow the very socket that replaced it —
      // with whatever it had declared frozen in its attachment. Harmless while
      // an attachment held nothing but identity; not harmless now that it says
      // whether the user is sharing their screen. handleDeparture already draws
      // the line in exactly this place.
      if (ws.readyState !== WebSocket.READY_STATE_OPEN) continue;

      const attachment = ws.deserializeAttachment() as Attachment | null;
      if (attachment) map.set(attachment.userId, attachment);
    }
    return map;
  }

  private broadcastAll(message: ServerMessage): void {
    const payload = encode(message);
    for (const ws of this.state.getWebSockets()) this.trySend(ws, payload);
  }

  private broadcastExcept(sender: WebSocket, message: ServerMessage): void {
    const payload = encode(message);
    for (const ws of this.state.getWebSockets()) {
      if (ws !== sender) this.trySend(ws, payload);
    }
  }

  private trySend(ws: WebSocket, payload: string): void {
    try {
      ws.send(payload);
    } catch {
      // Socket closed between enumeration and send; its close handler will
      // remove it. Nothing to do.
    }
  }

  private consumeToken(ws: WebSocket): boolean {
    const now = Date.now();
    const bucket = this.buckets.get(ws) ?? { tokens: RATE_LIMIT_MESSAGES, refilledAt: now };

    if (now - bucket.refilledAt >= RATE_LIMIT_WINDOW_MS) {
      bucket.tokens = RATE_LIMIT_MESSAGES;
      bucket.refilledAt = now;
    }

    if (bucket.tokens <= 0) {
      this.buckets.set(ws, bucket);
      return false;
    }

    bucket.tokens--;
    this.buckets.set(ws, bucket);
    return true;
  }

  private getMeta(): Promise<SessionMeta | undefined> {
    return this.state.storage.get<SessionMeta>("meta");
  }

  private putMeta(meta: SessionMeta): Promise<void> {
    return this.state.storage.put("meta", meta);
  }
}
