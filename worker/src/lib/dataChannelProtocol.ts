/**
 * The peer-to-peer half of the wire protocol.
 *
 * SHARED MODULE — imported by the React frontend. The Worker never sees these
 * frames, and that is the entire point: they travel over the WebRTC
 * DataChannel, directly between the two browsers, so they cost nothing.
 *
 * It lives beside protocol.ts because the two files are one contract split by
 * transport, and the split is not arbitrary. Every inbound WebSocket message
 * bills a Durable Object request against a 100,000/day budget. Cursor updates
 * alone run at 10 Hz (usePeerPresence.ts:35) — roughly 18,000 messages per
 * sender across a 30-minute screen-share, or over a third of the daily budget
 * for a single session. The five message types here are exactly the ones that
 * are both high-frequency and meaningless before the peer connection is up, so
 * moving them costs nothing in behaviour and takes a long session from ~36,000
 * Durable Object requests to under 100.
 *
 * What deliberately did NOT move: chat. It is low-volume, and it has to keep
 * working when the peer connection does not — someone needs to be able to type
 * "I can't see you."
 */

/** Envelope, mirroring protocol.ts. `d` is terse because cursor frames are hot. */
export interface DataEnvelope<T extends string = string, D = unknown> {
  t: T;
  d: D;
}

// ---------------------------------------------------------------------------
// Channels
//
// Two, because the traffic has two incompatible reliability profiles.
//
// Cursors are a stream of positions where only the newest matters; a reliable
// ordered channel would head-of-line block the current position behind the
// retransmit of one nobody will ever see. Video-sync is the opposite — a
// dropped 'play' desynchronises playback until someone notices and fixes it by
// hand.
//
// Both are negotiated with fixed ids so each side creates its own end without
// an ondatachannel handshake. That removes the offerer/answerer asymmetry: the
// channels exist from the moment the peer connection is built, and they are
// present in the very first SDP, so no extra renegotiation is needed.
// ---------------------------------------------------------------------------

export const FAST_CHANNEL = { label: "wt-fast", id: 0 } as const;
export const CONTROL_CHANNEL = { label: "wt-ctrl", id: 1 } as const;

/** Which channel a message type rides. */
export function channelFor(type: DataChannelMessage["t"]): "fast" | "control" {
  return type === "cursor" ? "fast" : "control";
}

// ---------------------------------------------------------------------------
// Caps
//
// The peer is authenticated but the client is not trusted — a modified one is
// on the far side of a direct connection with no server in between to sanitise
// anything. These bounds are the only validation these frames will ever get.
// ---------------------------------------------------------------------------

export const MAX_EMOJI_LENGTH = 16;
export const MAX_VIDEO_SYNC_PAYLOAD_LENGTH = 64;
export const MAX_DATA_FRAME_BYTES = 1_000;

export const VIDEO_SYNC_ACTIONS = ["load", "close", "play", "pause", "seek"] as const;
export type VideoSyncAction = (typeof VIDEO_SYNC_ACTIONS)[number];

export const QUALITY_LEVELS = ["excellent", "good", "fair", "poor", "critical"] as const;
export type QualityLevel = (typeof QUALITY_LEVELS)[number];

export interface QualityFeedback {
  level: QualityLevel;
  score: number;
  packetLossPercent: number;
  jitterMs: number;
  rttMs: number;
  fps: number;
}

// ---------------------------------------------------------------------------
// Messages
// ---------------------------------------------------------------------------

export type DataChannelMessage =
  /** Normalised 0..1 over the shared surface; the receiver re-projects. */
  | DataEnvelope<"cursor", { x: number; y: number }>
  | DataEnvelope<"typing", Record<string, never>>
  | DataEnvelope<"reaction", { emoji: string }>
  | DataEnvelope<"videoSync", { action: VideoSyncAction; payload: string }>
  | DataEnvelope<"quality", { feedback: QualityFeedback }>;

export type DataChannelMessageType = DataChannelMessage["t"];

export function encodeData(message: DataChannelMessage): string {
  return JSON.stringify(message);
}

/**
 * Parse a peer frame, returning null for anything malformed.
 *
 * Callers drop null silently, matching how the signalling path treats a bad
 * frame: presence traffic is best-effort in both directions, and a peer sending
 * garbage should degrade to "their cursor stopped moving", not to an error
 * dialog.
 */
export function decodeDataChannelMessage(raw: string): DataChannelMessage | null {
  if (raw.length > MAX_DATA_FRAME_BYTES) return null;

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

  return validateData(candidate.t, candidate.d as Record<string, unknown>);
}

/** In-range, finite, and not NaN — which `typeof x === "number"` alone allows. */
function unitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function validateData(type: string, d: Record<string, unknown>): DataChannelMessage | null {
  switch (type) {
    case "cursor":
      return unitInterval(d.x) && unitInterval(d.y) ? { t: "cursor", d: { x: d.x, y: d.y } } : null;

    case "typing":
      return { t: "typing", d: {} };

    case "reaction":
      return typeof d.emoji === "string" &&
        d.emoji.length > 0 &&
        d.emoji.length <= MAX_EMOJI_LENGTH
        ? { t: "reaction", d: { emoji: d.emoji } }
        : null;

    case "videoSync": {
      const action = d.action;
      if (!VIDEO_SYNC_ACTIONS.includes(action as VideoSyncAction)) return null;
      if (typeof d.payload !== "string" || d.payload.length > MAX_VIDEO_SYNC_PAYLOAD_LENGTH) {
        return null;
      }
      return { t: "videoSync", d: { action: action as VideoSyncAction, payload: d.payload } };
    }

    case "quality": {
      const feedback = d.feedback as Record<string, unknown> | undefined;
      if (typeof feedback !== "object" || feedback === null) return null;
      if (!QUALITY_LEVELS.includes(feedback.level as QualityLevel)) return null;
      if (
        !finite(feedback.score) ||
        !finite(feedback.packetLossPercent) ||
        !finite(feedback.jitterMs) ||
        !finite(feedback.rttMs) ||
        !finite(feedback.fps)
      ) {
        return null;
      }
      return {
        t: "quality",
        d: {
          feedback: {
            level: feedback.level as QualityLevel,
            score: feedback.score,
            packetLossPercent: feedback.packetLossPercent,
            jitterMs: feedback.jitterMs,
            rttMs: feedback.rttMs,
            fps: feedback.fps,
          },
        },
      };
    }

    default:
      return null;
  }
}
