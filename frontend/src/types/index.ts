// Post-C4: token is no longer client-visible. The JWT lives in an HttpOnly
// cookie set by /api/auth/login; JS can't read it (defence vs XSS theft).
// What's stored client-side is just public UI state — name, role, etc.
export interface User {
  email: string;
  displayName: string;
  isRootUser?: boolean;
  isInvitationTicketUsed?: boolean;
  hasAcceptedTerms?: boolean;
}

export interface LoginResponse {
  displayName: string;
  email: string;
  isRootUser: boolean;
  isInvitationTicketUsed: boolean;
  hasAcceptedTerms: boolean;
}

export interface PasskeyListItem {
  credentialIdBase64Url: string;
  label: string;
  aaGuid: string;
  registeredAt: string;
  lastUsedAt: string | null;
}

export interface MeResponse {
  email: string;
  displayName: string;
  isRootUser: boolean;
  isInvitationTicketUsed: boolean;
  hasAcceptedTerms: boolean;
}

// Registration
export interface ValidateInvitationResponse {
  isValid: boolean;
  inviterName?: string;
  message?: string;
}

export interface RegisterResponse {
  email: string;
  message: string;
}

export interface VerifyEmailResponse {
  success: boolean;
  message: string;
}

// Invitations
export interface InvitationSlots {
  maxSlots: number;
  /** Total slots taken — sum of pendingSlots + trulyUsedSlots. */
  usedSlots: number;
  /** Outstanding links (generated, not yet consumed, not expired). */
  pendingSlots: number;
  /** Links a friend has already registered through (UsedAt set). */
  trulyUsedSlots: number;
  remainingSlots: number;
  /** True when the user has no quota cap (root). When set, maxSlots /
   *  remainingSlots carry int.MaxValue as a sentinel — render "∞" not the
   *  raw number. UsedSlots / pendingSlots / trulyUsedSlots stay meaningful. */
  isUnlimited?: boolean;
}

export interface Invitation {
  id: string;
  inviteeEmail: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
}

export interface CreateInvitationResponse {
  success: boolean;
  message?: string;
  invitationLink?: string;
  invitation?: Invitation;
}

// New link-based invitation types
export interface GenerateLinkResponse {
  success: boolean;
  message?: string;
  inviteUrl?: string;
  expiresAt?: string;
}

export interface ValidateLinkResponse {
  valid: boolean;
  message?: string;
  inviterDisplayName?: string;
}

export interface ActiveLinkResponse {
  hasActiveLink: boolean;
  inviteUrl?: string;
  expiresAt?: string;
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

// Admin
export interface AdminUser {
  id: string;
  email: string;
  displayName: string;
  isRootUser: boolean;
  isEmailVerified: boolean;
  isInvitationTicketUsed: boolean;
  invitedByUserId: string | null;
  createdAt: string;
  hasAcceptedTerms: boolean;
}

export interface UserTreeNode {
  id: string;
  displayName: string;
  email: string;
  isRootUser: boolean;
  isEmailVerified: boolean;
  createdAt: string;
  children: UserTreeNode[];
}

export interface UserTreeResponse {
  root: UserTreeNode | null;
  totalUsers: number;
}

export interface AdminInvitation {
  id: string;
  inviterUserId: string;
  inviteeEmail: string;
  status: string;
  createdAt: string;
  expiresAt: string;
  usedAt?: string;
  registeredUserId?: string;
}

// Demo requests
export interface DemoRequestSubmitResponse {
  message: string;
}

export interface AdminDemoRequest {
  id: string;
  email: string;
  displayName: string;
  message?: string;
  status: string;
  submittedAt: string;
  reviewedAt?: string;
  reviewedByUserId?: string;
  rejectionReason?: string;
}

export interface ApproveDemoRequestResponse {
  message: string;
  invitationUrl?: string;
  expiresAt?: string;
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

export interface SpeedTestResult {
  uploadSpeedMbps: number;
  recommendedQuality: ScreenShareQuality;
  supportedQualities: Record<string, boolean>;
  timestamp: number;
}
