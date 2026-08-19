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

/**
 * A picture size in device pixels.
 *
 * Declared HERE, not in the frontend, because it travels. The frontend used to
 * declare its own `QualityFeedback` carrying a `viewport`, send it, and have
 * `validateData` below rebuild the frame field-by-field without one — so the
 * field was dropped on arrival and the receiver's size never reached the
 * sender at all. The whole point of this being a shared module is that the wire
 * shape has exactly one definition; a parallel copy on one side is how a
 * feature ships inert.
 */
export interface Viewport {
  width: number;
  height: number;
}

/** Largest picture dimension we will accept from a peer. 8K, generously. */
export const MAX_PICTURE_DIMENSION = 7680;
/** Smallest. Below this it is not a viewport, it is a typo or an attack. */
export const MIN_PICTURE_DIMENSION = 16;
/** Frame rates we are willing to believe a sender is targeting. */
export const MIN_SHARE_FPS = 1;
export const MAX_SHARE_FPS = 120;
/** `encoderImplementation` is a browser string; cap it before it is rendered. */
export const MAX_ENCODER_NAME_LENGTH = 32;

export const QUALITY_LIMITATIONS = ["none", "cpu", "bandwidth", "other"] as const;
export type QualityLimitation = (typeof QUALITY_LIMITATIONS)[number];

export interface QualityFeedback {
  level: QualityLevel;
  score: number;
  packetLossPercent: number;
  jitterMs: number;
  rttMs: number;
  fps: number;
  /**
   * How large the shared picture is actually being drawn on the receiver, in
   * device pixels. Optional: a peer on an older build sends none, and the
   * sender falls back to assuming 1080p (see resolutionBox).
   *
   * Rides the quality message rather than one of its own because it wants
   * exactly that message's lifecycle — sent only while a share is watched,
   * expiring on the same clock, cleared when the peer changes.
   */
  viewport?: Viewport;
}

/**
 * What the SHARER is doing, told to the viewer.
 *
 * The person who sees a screen share fail is not the person whose statistics
 * explain it. Every diagnostic in this app lived on the sender: what was asked
 * for, what the encoder produced, what limited it. The viewer — the one
 * watching the picture freeze — could see none of it, so a bug report could
 * only ever say "it looks choppy".
 *
 * It also carries the frame rate the sender is actually targeting, which the
 * viewer needs for a different reason: `calculateQualityScore` was judging a
 * 24 fps film share against 30 because it had no way to know better.
 */
export interface ShareStatus {
  /** Frame rate the sender is asking its encoder for. */
  fps: number;
  width: number;
  height: number;
  /** Video bitrate ceiling currently applied, bps. */
  bps: number;
  /** `qualityLimitationReason` from the sender's outbound-rtp, if known. */
  limitedBy?: QualityLimitation;
  /** e.g. 'libvpx-vp9', 'ExternalEncoder'. Software vs hardware, in one string. */
  encoder?: string;
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
  | DataEnvelope<"quality", { feedback: QualityFeedback }>
  | DataEnvelope<"share", { status: ShareStatus }>;

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

/** A picture dimension a peer could plausibly mean. */
function dimension(value: unknown): value is number {
  return (
    finite(value) && value >= MIN_PICTURE_DIMENSION && value <= MAX_PICTURE_DIMENSION
  );
}

/**
 * A viewport, or undefined.
 *
 * Undefined for BOTH "not sent" and "sent but malformed": the consumer already
 * has a conservative answer for the absent case (resolutionBox falls back to
 * 1080p), and giving a bad value the same treatment means one code path rather
 * than two. Never null — `viewport?:` is optional, not nullable.
 */
function readViewport(value: unknown): Viewport | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const v = value as Record<string, unknown>;
  if (!dimension(v.width) || !dimension(v.height)) return undefined;
  return { width: v.width, height: v.height };
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
      // Spread the optional field rather than assigning `undefined`: the frame
      // is JSON-encoded, and an explicit undefined would serialise the key away
      // anyway — but this keeps "absent" and "present" distinguishable in tests.
      const viewport = readViewport(feedback.viewport);
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
            ...(viewport ? { viewport } : {}),
          },
        },
      };
    }

    case "share": {
      const status = d.status as Record<string, unknown> | undefined;
      if (typeof status !== "object" || status === null) return null;
      if (!finite(status.fps) || status.fps < MIN_SHARE_FPS || status.fps > MAX_SHARE_FPS) {
        return null;
      }
      if (!dimension(status.width) || !dimension(status.height)) return null;
      if (!finite(status.bps) || status.bps < 0) return null;

      const limitedBy = QUALITY_LIMITATIONS.includes(status.limitedBy as QualityLimitation)
        ? (status.limitedBy as QualityLimitation)
        : undefined;
      // Truncate rather than reject: an unknown encoder string is still worth
      // showing, and a long one is a display problem, not a protocol violation.
      const encoder =
        typeof status.encoder === "string" && status.encoder.length > 0
          ? status.encoder.slice(0, MAX_ENCODER_NAME_LENGTH)
          : undefined;

      return {
        t: "share",
        d: {
          status: {
            fps: status.fps,
            width: status.width,
            height: status.height,
            bps: status.bps,
            ...(limitedBy ? { limitedBy } : {}),
            ...(encoder ? { encoder } : {}),
          },
        },
      };
    }

    default:
      return null;
  }
}
