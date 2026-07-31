/**
 * The signalling wire protocol.
 *
 * SHARED MODULE — imported by both the Worker and the React frontend. The .NET
 * version mirrored the hub contract by hand across two languages, so a change
 * on one side failed silently at runtime on the other. Here, drift is a
 * compile error.
 *
 * Ported from backend/API/Hubs/WatchTogetherHub.cs. Two structural changes:
 *
 *   1. No sessionId on any message. The socket is bound to a session by the
 *      Durable Object that owns it, so a client cannot address someone else's
 *      session. The hub's EnsureCallerInSession guard is not reimplemented —
 *      it is unrepresentable.
 *   2. High-frequency presence traffic (cursor, reactions, typing, video sync,
 *      quality) is NOT here. It rides the WebRTC DataChannel instead — every
 *      inbound WebSocket message bills a Durable Object request, and cursor
 *      updates alone at 10Hz would consume a third of the daily free budget in
 *      one screen-share. See dataChannelProtocol.ts.
 */

/** Envelope. `d` is terse because these frames are hot. */
export interface Envelope<T extends string = string, D = unknown> {
  t: T;
  d: D;
}

// ---------------------------------------------------------------------------
// Payload caps — WatchTogetherHub.cs:19-21
// ---------------------------------------------------------------------------

export const MAX_SDP_LENGTH = 30_000;
export const MAX_ICE_CANDIDATE_LENGTH = 2_000;
export const MAX_CHAT_MESSAGE_LENGTH = 5_000;

/**
 * Whole-frame ceiling, checked before JSON.parse so a hostile megabyte-long
 * string is dropped without spending CPU we do not have. Comfortably above the
 * largest legitimate frame (an SDP offer plus envelope overhead).
 */
export const MAX_FRAME_BYTES = 40_000;

/** Two participants, as in SessionService.cs:21. */
export const MAX_PARTICIPANTS = 2;

// ---------------------------------------------------------------------------
// Close codes
//
// Errors arrive as close codes rather than error frames because a browser
// cannot read a response body from a rejected WebSocket upgrade — `new
// WebSocket()` surfaces only a generic failure. Accepting the socket and then
// closing it with a specific code is the only way the client learns why.
// ---------------------------------------------------------------------------

export const CLOSE_REPLACED = 4000;
export const CLOSE_UNAUTHORIZED = 4001;
export const CLOSE_SESSION_NOT_FOUND = 4004;
export const CLOSE_SESSION_FULL = 4009;
export const CLOSE_PAYLOAD_TOO_LARGE = 4013;
export const CLOSE_RATE_LIMITED = 4029;

export const CLOSE_REASONS: Record<number, string> = {
  [CLOSE_REPLACED]: "replaced",
  [CLOSE_UNAUTHORIZED]: "unauthorized",
  [CLOSE_SESSION_NOT_FOUND]: "session_not_found",
  [CLOSE_SESSION_FULL]: "session_full",
  [CLOSE_PAYLOAD_TOO_LARGE]: "payload_too_large",
  [CLOSE_RATE_LIMITED]: "rate_limited",
};

// ---------------------------------------------------------------------------
// Shared payload shapes
// ---------------------------------------------------------------------------

export interface MediaState {
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
}

export interface ChatMessage {
  sender: string;
  message: string;
  /** ISO-8601, stamped server-side so peers cannot forge ordering. */
  timestamp: string;
}

// ---------------------------------------------------------------------------
// Client -> server
// ---------------------------------------------------------------------------

export type ClientMessage =
  | Envelope<"offer", { sdp: string }>
  | Envelope<"answer", { sdp: string }>
  | Envelope<"ice", { c: string }>
  | Envelope<"reoffer", { sdp: string }>
  | Envelope<"reanswer", { sdp: string }>
  | Envelope<"chat", { m: string }>
  | Envelope<"media", MediaState>
  | Envelope<"ss:req", Record<string, never>>
  | Envelope<"ss:res", { approved: boolean }>
  | Envelope<"ss:start", { streamId: string }>
  | Envelope<"ss:stop", Record<string, never>>
  | Envelope<"leave", Record<string, never>>;

export type ClientMessageType = ClientMessage["t"];

// ---------------------------------------------------------------------------
// Server -> client
//
// Names are byte-identical to the SignalR events they replace, so the
// frontend's existing handler table maps across one-to-one.
// ---------------------------------------------------------------------------

export interface JoinedPayload {
  you: { userId: string; username: string };
  /**
   * Whether this peer creates the WebRTC offer.
   *
   * Decided by the server, which knows the session creator. The React version
   * read this from router location.state, so a page refresh lost it and both
   * peers waited for an offer that never came.
   */
  isOfferer: boolean;
  capacity: number;
}

export type ServerMessage =
  | Envelope<"Joined", JoinedPayload>
  | Envelope<"PeerJoined", { name: string }>
  | Envelope<"ExistingPeer", { name: string }>
  | Envelope<"PeerLeft", { name: string }>
  | Envelope<"PeerReconnected", { name: string }>
  | Envelope<"ReceiveOffer", { sdp: string; name: string }>
  | Envelope<"ReceiveAnswer", { sdp: string }>
  | Envelope<"ReceiveIceCandidate", { c: string }>
  | Envelope<"ReceiveChatMessage", ChatMessage>
  | Envelope<"PeerMediaStateChanged", { name: string; state: MediaState }>
  | Envelope<"ScreenShareRequested", { name: string }>
  | Envelope<"ScreenShareResponse", { approved: boolean; name: string }>
  | Envelope<"ScreenShareStarted", { name: string; streamId: string }>
  | Envelope<"ScreenShareStopped", { name: string }>
  | Envelope<"ReceiveRenegotiationOffer", { sdp: string }>
  | Envelope<"ReceiveRenegotiationAnswer", { sdp: string }>
  | Envelope<"Error", { code: number; message: string }>;

export type ServerMessageType = ServerMessage["t"];

/**
 * The one message echoed back to its sender.
 *
 * SendChatMessage used Clients.Group rather than Clients.OthersInGroup
 * (WatchTogetherHub.cs:141), and the frontend leans on it: the send handler
 * does not append locally, so a sender's own messages appear only via this
 * echo. Switching chat to others-only makes your own messages vanish from your
 * own chat — a bug that looks like a rendering fault, not a protocol one.
 *
 * The inverse trap: reactions ARE echoed locally by the client, so anything
 * reaction-shaped must never be broadcast back to its sender.
 */
export const ECHOES_TO_SENDER: ReadonlySet<ClientMessageType> = new Set<ClientMessageType>([
  "chat",
]);

export function encode(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a client frame, returning null for anything malformed.
 *
 * Callers drop null silently, matching the hub's behaviour of ignoring
 * oversized and blank payloads without surfacing an error.
 */
export function decodeClientMessage(raw: string): ClientMessage | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== "object" || parsed === null) return null;

  const candidate = parsed as { t?: unknown; d?: unknown };
  if (typeof candidate.t !== "string") return null;
  if (typeof candidate.d !== "object" || candidate.d === null) return null;

  return validate(candidate.t, candidate.d as Record<string, unknown>);
}

/** Non-empty string within a length cap. Blank and oversized both fail. */
function str(value: unknown, cap: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= cap;
}

function validate(type: string, d: Record<string, unknown>): ClientMessage | null {
  switch (type) {
    case "offer":
    case "answer":
    case "reoffer":
    case "reanswer":
      return str(d.sdp, MAX_SDP_LENGTH) ? ({ t: type, d: { sdp: d.sdp } } as ClientMessage) : null;

    case "ice":
      return str(d.c, MAX_ICE_CANDIDATE_LENGTH) ? { t: "ice", d: { c: d.c } } : null;

    case "chat":
      return str(d.m, MAX_CHAT_MESSAGE_LENGTH) ? { t: "chat", d: { m: d.m } } : null;

    case "media":
      return typeof d.isMuted === "boolean" &&
        typeof d.isCameraOn === "boolean" &&
        typeof d.isScreenSharing === "boolean"
        ? {
            t: "media",
            d: {
              isMuted: d.isMuted,
              isCameraOn: d.isCameraOn,
              isScreenSharing: d.isScreenSharing,
            },
          }
        : null;

    case "ss:res":
      return typeof d.approved === "boolean" ? { t: "ss:res", d: { approved: d.approved } } : null;

    case "ss:start":
      // streamId is an opaque WebRTC identifier; cap it at the ICE length
      // rather than leaving it unbounded as the hub did.
      return str(d.streamId, MAX_ICE_CANDIDATE_LENGTH)
        ? { t: "ss:start", d: { streamId: d.streamId } }
        : null;

    case "ss:req":
      return { t: "ss:req", d: {} };
    case "ss:stop":
      return { t: "ss:stop", d: {} };
    case "leave":
      return { t: "leave", d: {} };

    default:
      return null;
  }
}
