// The JWT lives in an HttpOnly cookie; JS cannot read it. What is stored
// client-side is just public UI state — name, role, terms.
//
// Identity is `username#1234`, not an email. The discriminator is generated at
// registration and never chosen, so two people can both be "kutay" without one
// of them having to be kutay_47. `username` alone is what peers see in chat and
// in the session; `tag` is the full handle, used wherever identity has to be
// unambiguous (settings, admin, invites).
export interface User {
  username: string;
  discriminator: string;
  /** `username#1234`, precomputed server-side so the two never drift apart. */
  tag: string;
  isRootUser?: boolean;
  hasAcceptedTerms?: boolean;
}

/** Returned by every endpoint that establishes a session. */
export interface LoginResponse {
  username: string;
  discriminator: string;
  tag: string;
  isRootUser: boolean;
  hasAcceptedTerms: boolean;
}

export interface PasskeyListItem {
  credentialId: string;
  label: string;
  aaguid: string | null;
  /** Unix millis. */
  registeredAt: number;
  lastUsedAt: number | null;
  backedUp: boolean;
}

export type MeResponse = LoginResponse;

/**
 * What the wire carries in place of a password.
 *
 * The plaintext never leaves the browser: `clientKey` is 32 stretched bytes,
 * base64url. `clientKdfVersion` names the recipe that produced them so the
 * server can record it alongside the hash. Built by hooks/usePasswordField.ts;
 * no other module should be assembling one.
 */
export interface PasswordCredential {
  clientKey: string;
  clientKdfVersion: number;
}

/** Probe result for `/reset/:token`, before anything is typed into it. */
export interface PasswordResetStatus {
  valid: boolean;
  /** Present when valid — the client salt, so the browser can derive a key. */
  username?: string;
  tag?: string;
  reason?: 'not_found' | 'expired' | 'used';
}

// Registration
export interface ValidateInvitationResponse {
  isValid: boolean;
  inviterName?: string;
  message?: string;
}

// Invitations — shapes mirror worker/src/routes/invitation.ts.
export interface InvitationSlots {
  /** null for root, who has no cap. Render "∞" rather than a sentinel number. */
  maxSlots: number | null;
  usedSlots: number;
  remainingSlots: number | null;
  isUnlimited: boolean;
}

export interface GenerateLinkResponse {
  success: boolean;
  message?: string;
  inviteUrl?: string;
  /** Unix millis. */
  expiresAt?: number;
}

export interface ValidateLinkResponse {
  valid: boolean;
  message?: string;
  /** `username#1234` of whoever minted the link. */
  inviterTag?: string | null;
}

export interface ActiveLinkResponse {
  hasActiveLink: boolean;
  /**
   * Deliberately absent — the raw token exists only in the response that minted
   * it, so an outstanding link can be reported but never re-shown.
   */
  expiresAt: number | null;
}

export interface IceServer {
  urls: string;
  username?: string;
  credential?: string;
}

export interface IceServerConfig {
  iceServers: IceServer[];
}

export interface ChatMessage {
  sender: string;
  message: string;
  timestamp: string;
}

export interface MediaState {
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
}

/** ICE candidate types, in the order RFC 8445 prefers them. */
export type IceCandidateKind = 'host' | 'srflx' | 'prflx' | 'relay';

/**
 * Which path the media is actually taking.
 *
 * Nothing in the app confirmed this before, and the two failure modes it
 * distinguishes look identical from the outside: `worker/src/lib/ice.ts`
 * degrades to STUN-only on any TURN mint failure rather than erroring, and a
 * peer behind symmetric NAT then silently falls back to a relay that was never
 * minted (i.e. fails) — or succeeds over a relay and pays the extra hop's RTT.
 * "Is this actually peer-to-peer" is the first question to answer before
 * judging any encoder tuning, so it has to be observable.
 */
export interface TransportPath {
  local: IceCandidateKind;
  remote: IceCandidateKind;
  /** Transport of the candidate pair itself — 'udp' or 'tcp'. */
  protocol: string;
  /** How we reach the TURN server, when `local` is a relay: udp | tcp | tls. */
  relayProtocol?: string;
  isRelayed: boolean;
  rttMs: number | null;
}

/**
 * The full ICE picture, for answering *why* a session landed on the path it did.
 *
 * `TransportPath` says "you are relayed over TCP". It cannot say why, and the
 * three reasons want three different fixes:
 *
 *  - a relay/udp local candidate exists, but its pair has `requestsSent > 0`
 *    and `responsesReceived === 0` → UDP to the TURN server is being dropped,
 *    by the carrier or by the local network. Nothing client-side fixes it.
 *  - no relay/udp local candidate at all → gathering never produced one, which
 *    points at the minted iceServers list (see `offeredUrls`).
 *  - a succeeded UDP pair that lost to a nominated TCP pair → nomination
 *    ordering, and ours to fix.
 *
 * Today all three look identical from the outside, which is why the reported
 * 231 ms TURN/TCP session could not be diagnosed from the overlay alone.
 *
 * Deliberately carries NO candidate addresses and NO TURN credentials: this is
 * meant to be pasted into a bug report.
 */
export interface IceCandidateInfo {
  id: string;
  candidateType: IceCandidateKind;
  protocol: string;
  relayProtocol?: string;
  /** Which configured server produced it — the STUN/TURN URL, never the creds. */
  url?: string;
  networkType?: string;
}

export interface IceCandidatePairInfo {
  state: string;
  nominated: boolean;
  selected: boolean;
  localCandidateId?: string;
  remoteCandidateId?: string;
  requestsSent: number | null;
  responsesReceived: number | null;
  rttMs: number | null;
  availableOutgoingBitrate: number | null;
  bytesSent: number | null;
}

export interface IceDiagnostics {
  /** The iceServers we were configured with. URLs only. */
  offeredUrls: string[];
  local: IceCandidateInfo[];
  remote: IceCandidateInfo[];
  pairs: IceCandidatePairInfo[];
  gatheringState: string;
  connectionState: string;
}

/**
 * What the screen-share encoder is actually doing, as opposed to what it was
 * asked to do. `targetBitrate` sitting far below the configured ceiling with
 * `qualityLimitationReason === 'bandwidth'` is the signal that the link cannot
 * carry the current operating point; the same gap with reason `'cpu'` means the
 * opposite and must never be answered by lowering the bitrate.
 */
export interface OutboundScreenStats {
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /** What the rate controller is aiming for right now, bps. */
  targetBitrate: number | null;
  qualityLimitationReason: 'none' | 'cpu' | 'bandwidth' | 'other' | null;
  /** e.g. 'libvpx-vp9', 'ExternalEncoder' — how Step 6 detects hardware AV1. */
  encoderImplementation: string | null;
  /** Seconds of encode time across `framesEncoded`; the CPU-cliff detector. */
  totalEncodeTime: number | null;
  framesEncoded: number | null;
}

/**
 * What kind of thing is on the screen, which is really a question about frame
 * rate — and frame rate is the cheapest quality lever in the whole system.
 *
 * Film and series are 24 fps at source. Encoding them at 30 spends the budget
 * across 25% more frames than carry any information, so every frame gets 25%
 * fewer bits to describe itself. Dropping to 24 on 24 fps content is free
 * sharpness: nothing is lost, because there was nothing there.
 *
 * Games are the opposite case and get 60 where the budget allows.
 */
export type ContentMode = 'film' | 'motion' | 'games';

export const CONTENT_MODES: Record<ContentMode, { label: string; description: string; fps: number }> = {
  film: { label: 'Film', description: 'movies & series — 24 fps, sharpest', fps: 24 },
  motion: { label: 'Motion', description: 'general video — 30 fps', fps: 30 },
  games: { label: 'Games', description: 'fast action — 60 fps, smoothest', fps: 60 },
};

/**
 * Screen share quality — now a CEILING the user picks, not a fixed operating
 * point.
 *
 * The numbers that actually reach the encoder come from
 * `chooseOperatingPoint()`, which sits the resolution on the rate-distortion
 * convex hull for whatever bandwidth is measured. These presets bound that
 * choice from above: `low` means "never spend more than 1.5 Mbps and never
 * exceed 720p", `auto` means "up to 1080p, let the link decide".
 */
export type ScreenShareQuality = 'auto' | 'low' | 'medium' | 'high' | 'ultra' | 'extreme';

/** Ladder order, cheapest first. The single source of this ordering. */
export const QUALITY_LADDER: readonly ScreenShareQuality[] = [
  'low',
  'medium',
  'high',
  'ultra',
  'extreme',
];

/**
 * Guard for values read back from localStorage.
 *
 * `saved as ScreenShareQuality` was an unchecked cast, so any stale or
 * unrecognised string flowed into QUALITY_PRESETS[quality], yielded undefined,
 * and threw on `preset.video.bitrate` inside captureScreen.
 */
export function isScreenShareQuality(v: unknown): v is ScreenShareQuality {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(QUALITY_PRESETS, v);
}

/** Same guard for the content mode. */
export function isContentMode(v: unknown): v is ContentMode {
  return typeof v === 'string' && Object.prototype.hasOwnProperty.call(CONTENT_MODES, v);
}

export interface QualityPreset {
  label: string;
  description: string;
  video: {
    width: number;
    height: number;
    frameRate: number;
    bitrate: number; // in bps
  };
  audio: {
    bitrate: number; // in bps
  };
}

/**
 * Screen-share quality ceilings.
 *
 * These are upper bounds, not targets. `chooseOperatingPoint()` picks the
 * actual width/height/fps/bitrate from the measured budget and clamps the
 * result to whichever preset the user selected; a preset never forces the
 * encoder UP to its numbers, only stops it going past them.
 *
 * `frameRate` is 60 everywhere because the content mode (film/motion/games)
 * owns frame rate now — the preset only prevents a mode asking for more than
 * the tier allows.
 *
 * `bitrate: 0` on `auto` means "the budget decides", NOT "uncapped". Uncapped
 * was the old behaviour and it was the single worst state in the system: an
 * unbounded encoder on a slow link overshoots, builds a standing queue, and
 * goes soft AND laggy at once. AUTO_MAX_BITRATE in operatingPoint.ts is the
 * hard safety ceiling that replaces it.
 *
 * The encoder runs `degradationPreference='maintain-framerate'` with
 * scaleResolutionDownBy deliberately unpinned (see
 * webrtcService.applyVideoEncoding), so under pressure the stream stays SMOOTH
 * and sheds resolution rather than going choppy.
 */
export const QUALITY_PRESETS: Record<ScreenShareQuality, QualityPreset> = {
  auto: {
    label: 'Auto',
    description: 'up to 1080p • follows your link',
    video: { width: 1920, height: 1080, frameRate: 60, bitrate: 0 }, // 0 = budget decides
    audio: { bitrate: 96000 },
  },
  low: {
    label: 'Low',
    description: 'up to 720p • 1.5 Mbps cap',
    video: { width: 1280, height: 720, frameRate: 60, bitrate: 1500000 },
    audio: { bitrate: 64000 },
  },
  medium: {
    label: 'Medium',
    description: 'up to 1080p • 4 Mbps cap',
    video: { width: 1920, height: 1080, frameRate: 60, bitrate: 4000000 },
    audio: { bitrate: 96000 },
  },
  high: {
    label: 'High',
    description: 'up to 1080p • 8 Mbps cap',
    video: { width: 1920, height: 1080, frameRate: 60, bitrate: 8000000 },
    audio: { bitrate: 128000 },
  },
  ultra: {
    label: 'Ultra',
    description: 'up to 4K • 15 Mbps cap',
    video: { width: 3840, height: 2160, frameRate: 60, bitrate: 15000000 },
    audio: { bitrate: 256000 },
  },
  extreme: {
    label: 'Extreme',
    description: 'up to 4K • 28 Mbps cap',
    video: { width: 3840, height: 2160, frameRate: 60, bitrate: 28000000 },
    audio: { bitrate: 320000 },
  },
};

export interface SessionValidation {
  exists: boolean;
  valid: boolean;
  participantCount: number;
}

// Session invite types
export interface SessionInviteResponse {
  success: boolean;
  inviteUrl?: string;
  expiresAt?: string;
}

export interface ValidateSessionInviteResponse {
  valid: boolean;
  message?: string;
  sessionId?: string;
  creatorDisplayName?: string;
}

export interface JoinWithInviteResponse {
  success: boolean;
  sessionId?: string;
}

// Admin — shapes mirror worker/src/routes/admin.ts's UserSummary exactly.
export interface AdminUser {
  id: string;
  username: string;
  discriminator: string;
  tag: string;
  isRootUser: boolean;
  invitedByUserId: string | null;
  /** Unix millis. */
  createdAt: number;
  isDeleted: boolean;
}

export interface UserTreeNode extends AdminUser {
  children: UserTreeNode[];
}

export interface UserTreeResponse {
  root: UserTreeNode | null;
  /** Users whose inviter is missing — soft-deleted, or data predating the tree. */
  orphans?: UserTreeNode[];
  totalUsers: number;
}

export interface AuditEntry {
  id: string;
  actorUserId: string;
  actorTag: string | null;
  action: string;
  targetType: string;
  targetId: string;
  details: string | null;
  createdAt: number;
}

// Network quality monitoring types
export type QualityLevel = 'excellent' | 'good' | 'fair' | 'poor' | 'critical';

export interface QualityFeedback {
  level: QualityLevel;
  score: number;
  packetLossPercent: number;
  jitterMs: number;
  rttMs: number;
  fps: number;
}

/**
 * What the bandwidth estimator thinks this connection's uplink can carry, and
 * which screen-share presets therefore fit. Derived from the peer connection's
 * own `availableOutgoingBitrate` — see hooks/useUplinkEstimate.ts.
 *
 * Null everywhere it appears means "no opinion", not "slow": a browser that
 * does not publish the statistic must leave the user's choice alone.
 */
export interface UplinkEstimate {
  uplinkMbps: number;
  /** Unrounded, for arithmetic. uplinkMbps is rounded for display only. */
  uplinkBps: number;
  /** Spendable budget: the estimate after headroom. Feeds chooseOperatingPoint. */
  budgetBps: number;
  recommendedQuality: ScreenShareQuality;
  supportedQualities: Record<ScreenShareQuality, boolean>;
  /**
   * Bits per second we are demonstrably putting on the wire, from the delta in
   * the candidate pair's `bytesSent`. A measured lower bound, not a ceiling.
   */
  observedBps: number | null;
  /**
   * Whether `uplinkBps` came from a measurement we trust as CAPACITY.
   *
   * False means it is an observation-only lower bound — we know the link
   * carries at least this much, and nothing about how much more. That happens
   * on a TCP-relayed path, where `availableOutgoingBitrate` is a number about
   * TCP rather than about the path, and whenever bytes we actually sent
   * contradict the estimator outright.
   *
   * A false here must never produce negative advice: the reported failure had
   * a bogus 30 kbps estimate grey out all five fixed presets, removing the one
   * manual escape the user had from the collapse.
   */
  capacityKnown: boolean;
}
