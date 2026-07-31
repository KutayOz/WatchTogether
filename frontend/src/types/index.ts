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

// Screen share quality presets
export type ScreenShareQuality = 'auto' | 'low' | 'medium' | 'high' | 'ultra' | 'extreme';

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
 * Screen-share quality ladder.
 *
 * Smoothness note: the encoder now runs with degradationPreference=
 * 'maintain-framerate' (see webrtcService.applyVideoEncoding). That means
 * when a preset's `bitrate` is too low to sustain its width×height at
 * `frameRate`, the stream stays SMOOTH and instead drops resolution
 * (gets softer) — it no longer goes choppy. So for motion content
 * (film/dizi/oyun) these bitrates control sharpness-under-load, not
 * smoothness. Frame rate: 30 is plenty for film/dizi (24–30 fps source);
 * 60 mainly helps fast games. Tune per your TURN bandwidth budget.
 */
export const QUALITY_PRESETS: Record<ScreenShareQuality, QualityPreset> = {
  auto: {
    label: 'Auto',
    description: 'Adapts to network',
    video: { width: 1920, height: 1080, frameRate: 30, bitrate: 0 }, // 0 = no limit, let WebRTC adapt
    audio: { bitrate: 128000 },
  },
  low: {
    label: 'Low',
    description: '720p30 • 1.5 Mbps',
    video: { width: 1280, height: 720, frameRate: 30, bitrate: 1500000 },
    audio: { bitrate: 96000 },
  },
  medium: {
    label: 'Medium',
    description: '1080p30 • 4 Mbps',
    video: { width: 1920, height: 1080, frameRate: 30, bitrate: 4000000 },
    audio: { bitrate: 128000 },
  },
  high: {
    label: 'High',
    description: '1080p30 • 8 Mbps',
    video: { width: 1920, height: 1080, frameRate: 30, bitrate: 8000000 },
    audio: { bitrate: 256000 },
  },
  ultra: {
    label: 'Ultra',
    description: '4K60 • 15 Mbps',
    video: { width: 3840, height: 2160, frameRate: 60, bitrate: 15000000 },
    audio: { bitrate: 320000 },
  },
  extreme: {
    label: 'Extreme',
    description: '4K60 • 28 Mbps',
    video: { width: 3840, height: 2160, frameRate: 60, bitrate: 28000000 },
    audio: { bitrate: 510000 }, // Near max Opus bitrate
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
  recommendedQuality: ScreenShareQuality;
  supportedQualities: Record<ScreenShareQuality, boolean>;
}
