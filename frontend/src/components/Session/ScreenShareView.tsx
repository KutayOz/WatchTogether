import { logger } from '../../services/logger';
import { useEffect, useRef, useState, useCallback } from 'react';
import { MediaControls } from '../Controls/MediaControls';
import { QualityIndicator } from '../Quality/QualityIndicator';
import { StickerButton, BurstSticker, Doodle, SFX } from '../manga';
import type { QualityLevel } from '../../types';

interface ScreenShareViewProps {
  screenStream: MediaStream | null;
  isLocalSharing: boolean;
  sharerName: string | null;
  onRequestShare: () => void;
  canRequestShare: boolean;
  isWaitingForApproval: boolean;
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  canShare: boolean;
  remoteCameraStream: MediaStream | null;
  /** Local camera stream — used for the picture-in-self tile in the
   *  "peer-large" empty state (no screen share active). */
  localStream?: MediaStream | null;
  peerDisplayName: string | null;
  peerHasLeft: boolean;
  peerIsMuted?: boolean;
  peerIsCameraOff?: boolean;
  qualityLevel?: QualityLevel | null;
  peerQualityLevel?: QualityLevel | null;
  onHasScreenAudioChange?: (hasAudio: boolean) => void;
  externalScreenAudioVolume?: number;
  /** Peer's pointer position over the shared content. Normalized 0..1 so
   *  it survives resolution changes. Pass null to hide the halo. */
  peerCursor?: { x: number; y: number; name: string } | null;
  /** Fired on every mousemove over the shared content (normalized 0..1).
   *  Parent throttles upstream (~10Hz over the wire). */
  onLocalCursor?: (x: number, y: number) => void;
}

export function ScreenShareView({
  screenStream,
  isLocalSharing,
  sharerName,
  onRequestShare,
  canRequestShare,
  isWaitingForApproval,
  isMuted,
  isCameraOn,
  isScreenSharing,
  onToggleMute,
  onToggleCamera,
  onToggleScreenShare,
  onLeave,
  canShare,
  remoteCameraStream,
  localStream,
  peerDisplayName,
  peerHasLeft,
  peerIsMuted,
  peerIsCameraOff,
  qualityLevel,
  peerQualityLevel,
  onHasScreenAudioChange,
  externalScreenAudioVolume,
  peerCursor,
  onLocalCursor,
}: ScreenShareViewProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const remoteCameraRef = useRef<HTMLVideoElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const pipRef = useRef<HTMLDivElement>(null);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [hideOverlay, setHideOverlay] = useState(false);
  const [hasAudioTrack, setHasAudioTrack] = useState(false);
  const [audioVolume, setAudioVolume] = useState(100);
  const [showPeerCamera, setShowPeerCamera] = useState(true);
  const [isTouchDevice, setIsTouchDevice] = useState(false);
  const autoHideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // PiP dragging
  const [pipPosition, setPipPosition] = useState({ x: 0, y: 0 });
  const [isDragging, setIsDragging] = useState(false);
  const dragStartRef = useRef({ x: 0, y: 0, pipX: 0, pipY: 0 });

  // Video stream. useWebRTC hands us a *new* MediaStream object on every track
  // event (e.g. when the screen-share audio track arrives just after the video
  // track). Re-assigning srcObject each time forces the <video> to tear down and
  // re-prime its decode pipeline — a visible freeze right as playback starts and
  // on every later renegotiation. So only (re)assign when the underlying VIDEO
  // track id actually changes (or we go to/from null); otherwise the element
  // keeps playing uninterrupted and picks up track mutations on its own.
  useEffect(() => {
    const el = videoRef.current;
    if (!el) return;
    try {
      const currentVideoId = (el.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id ?? null;
      const nextVideoId = screenStream?.getVideoTracks()[0]?.id ?? null;
      if (nextVideoId !== currentVideoId) {
        el.srcObject = screenStream;
      }
    } catch (err) {
      logger.error('[ScreenShare] Error setting video stream:', err);
    }
  }, [screenStream]);

  // Audio stream
  useEffect(() => {
    if (isLocalSharing) {
      setHasAudioTrack(false);
      onHasScreenAudioChange?.(false);
      return;
    }

    if (!screenStream) {
      setHasAudioTrack(false);
      onHasScreenAudioChange?.(false);
      if (audioRef.current) {
        audioRef.current.srcObject = null;
      }
      return;
    }

    try {
      const audioTracks = screenStream.getAudioTracks();
      const hasAudio = audioTracks.length > 0;
      setHasAudioTrack(hasAudio);
      onHasScreenAudioChange?.(hasAudio);

      if (hasAudio && audioRef.current) {
        const audioStream = new MediaStream(audioTracks);
        audioRef.current.srcObject = audioStream;
        const volume = externalScreenAudioVolume !== undefined ? externalScreenAudioVolume : audioVolume;
        audioRef.current.volume = volume / 100;
        audioRef.current.play().catch((err) => {
          logger.debug('[ScreenShare] Audio autoplay blocked, will play on interaction:', err.message);
        });
      }
    } catch (err) {
      logger.error('[ScreenShare] Error setting audio stream:', err);
      setHasAudioTrack(false);
      onHasScreenAudioChange?.(false);
    }
  }, [screenStream, isLocalSharing, audioVolume, onHasScreenAudioChange, externalScreenAudioVolume]);

  useEffect(() => {
    if (audioRef.current && externalScreenAudioVolume !== undefined) {
      audioRef.current.volume = externalScreenAudioVolume / 100;
    }
  }, [externalScreenAudioVolume]);

  // Remote camera for PiP
  useEffect(() => {
    if (remoteCameraRef.current && remoteCameraStream) {
      remoteCameraRef.current.srcObject = remoteCameraStream;
    }
  }, [remoteCameraStream, isFullscreen, showPeerCamera]);

  // Fullscreen change events
  useEffect(() => {
    const handleFullscreenChange = () => {
      const fullscreenEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
      const isNowFullscreen = !!fullscreenEl;
      setIsFullscreen(isNowFullscreen);
      if (!isNowFullscreen) {
        setHideOverlay(false);
        setPipPosition({ x: 0, y: 0 });
      }
    };

    document.addEventListener('fullscreenchange', handleFullscreenChange);
    document.addEventListener('webkitfullscreenchange', handleFullscreenChange);
    return () => {
      document.removeEventListener('fullscreenchange', handleFullscreenChange);
      document.removeEventListener('webkitfullscreenchange', handleFullscreenChange);
    };
  }, []);

  useEffect(() => {
    const hasTouch = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
    setIsTouchDevice(hasTouch);
  }, []);

  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isFullscreen) {
        const exitFullscreen = document.exitFullscreen || (document as unknown as { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen;
        if (exitFullscreen) {
          exitFullscreen.call(document);
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isFullscreen]);

  // Auto-hide overlays after a few seconds of no input. Sector default is
  // 2-4s (Zoom 2s, Meet 3s, YouTube/Video.js 2s) — we pick 3s as a balance
  // between "snappy reveal" and "fade noise on micro-movements." Only runs
  // in fullscreen: in windowed mode the controls share space with the rest
  // of the page, hiding them creates a worse "where did they go" surprise.
  //
  // Touch unifies with desktop: 3s either way, and a tap toggles. The old
  // touch-only 5s was longer to absorb scroll inertia, but the unified
  // timer reset on every touchstart/touchmove fixes that without needing
  // a different ceiling.
  useEffect(() => {
    if (!isFullscreen) {
      setHideOverlay(false);
      return;
    }

    const HIDE_AFTER_MS = 3000;
    const reset = () => {
      setHideOverlay(false);
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
      autoHideTimerRef.current = setTimeout(() => setHideOverlay(true), HIDE_AFTER_MS);
    };

    reset();
    // mousemove fires constantly in fullscreen — that's the desktop signal.
    // keydown covers volume keys / arrows. touchstart + touchmove handle
    // mobile/tablet without distinguishing them from desktop.
    window.addEventListener('mousemove', reset);
    window.addEventListener('keydown', reset);
    window.addEventListener('touchstart', reset, { passive: true });
    window.addEventListener('touchmove', reset, { passive: true });

    return () => {
      if (autoHideTimerRef.current) clearTimeout(autoHideTimerRef.current);
      window.removeEventListener('mousemove', reset);
      window.removeEventListener('keydown', reset);
      window.removeEventListener('touchstart', reset);
      window.removeEventListener('touchmove', reset);
    };
  }, [isFullscreen]);

  const handleScreenTap = useCallback(() => {
    // On touch devices, tapping the screen explicitly toggles the overlay —
    // gives the user a deterministic way to reveal controls if they were
    // mid-idle. Desktop click is a no-op (mousemove already reveals).
    if (isFullscreen && isTouchDevice) {
      setHideOverlay((prev) => !prev);
    }
  }, [isFullscreen, isTouchDevice]);

  // Bottom-area reveal kept as a *secondary* signal: even within the 3s idle
  // window, dragging the cursor toward the bottom edge surfaces controls
  // sooner. Helpful when the user *intentionally* reaches for the bar.
  const handleMouseMove = useCallback(
    (e: React.MouseEvent) => {
      const container = containerRef.current;
      if (!container) return;
      const rect = container.getBoundingClientRect();

      // Cursor sharing — normalize to 0..1 over the container box, regardless
      // of size. The peer projects this back onto its own container, so
      // resolution differences (4K host, 1080p viewer) don't distort the
      // pointed-at spot. Parent throttles the wire send.
      if (onLocalCursor && rect.width > 0 && rect.height > 0) {
        const nx = (e.clientX - rect.left) / rect.width;
        const ny = (e.clientY - rect.top) / rect.height;
        if (nx >= 0 && nx <= 1 && ny >= 0 && ny <= 1) {
          onLocalCursor(nx, ny);
        }
      }

      // Bottom-area reveal stays as fullscreen-only.
      if (!isFullscreen || isTouchDevice) return;
      const bottomThreshold = rect.height * 0.15;
      const isInBottomArea = e.clientY > rect.bottom - bottomThreshold;
      if (isInBottomArea && hideOverlay) setHideOverlay(false);
    },
    [isFullscreen, isTouchDevice, hideOverlay, onLocalCursor]
  );

  // PiP drag
  const handlePipMouseDown = useCallback(
    (e: React.MouseEvent) => {
      if (!pipRef.current) return;
      e.preventDefault();
      setIsDragging(true);
      dragStartRef.current = {
        x: e.clientX,
        y: e.clientY,
        pipX: pipPosition.x,
        pipY: pipPosition.y,
      };
    },
    [pipPosition]
  );

  useEffect(() => {
    if (!isDragging) return;

    const handleMouseMoveDrag = (e: MouseEvent) => {
      const deltaX = e.clientX - dragStartRef.current.x;
      const deltaY = e.clientY - dragStartRef.current.y;
      setPipPosition({
        x: dragStartRef.current.pipX + deltaX,
        y: dragStartRef.current.pipY + deltaY,
      });
    };

    const handleMouseUp = () => setIsDragging(false);

    window.addEventListener('mousemove', handleMouseMoveDrag);
    window.addEventListener('mouseup', handleMouseUp);

    return () => {
      window.removeEventListener('mousemove', handleMouseMoveDrag);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [isDragging]);

  const toggleFullscreen = useCallback(async () => {
    if (!containerRef.current) return;
    try {
      const fullscreenEl = document.fullscreenElement || (document as unknown as { webkitFullscreenElement?: Element }).webkitFullscreenElement;
      if (!fullscreenEl) {
        const requestFullscreen =
          containerRef.current.requestFullscreen ||
          (containerRef.current as unknown as { webkitRequestFullscreen?: () => Promise<void> }).webkitRequestFullscreen;
        if (requestFullscreen) {
          await requestFullscreen.call(containerRef.current);
        }
      } else {
        const exitFullscreen = document.exitFullscreen || (document as unknown as { webkitExitFullscreen?: () => Promise<void> }).webkitExitFullscreen;
        if (exitFullscreen) {
          await exitFullscreen.call(document);
        }
      }
    } catch (err) {
      logger.error('[ScreenShare] Fullscreen error:', err);
    }
  }, []);

  const handleVolumeChange = useCallback((newVolume: number) => {
    setAudioVolume(newVolume);
    if (audioRef.current) {
      audioRef.current.volume = newVolume / 100;
      audioRef.current.muted = newVolume === 0;
    }
  }, []);

  /* ────────────────────────────────────────────────────────── */
  /* Empty state — no one is sharing                            */
  /* ────────────────────────────────────────────────────────── */
  if (!screenStream && !sharerName) {
    if (peerHasLeft) {
      return (
        <div
          style={{
            height: '100%',
            display: 'grid',
            placeItems: 'center',
            border: '4px solid var(--ink)',
            borderRadius: 6,
            background: 'var(--cream)',
            boxShadow: '6px 6px 0 var(--ink)',
            position: 'relative',
            overflow: 'hidden',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <BurstSticker bg="var(--orange)" rot={-4} w={240} h={150}>
              BYE!
            </BurstSticker>
            <p className="hand" style={{ fontSize: 22, marginTop: 18 }}>
              peer left the session
            </p>
            <p className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)', marginTop: 4 }}>
              share the session link to invite someone
            </p>
          </div>
        </div>
      );
    }

    // ─────────────── Peer-large layout (no screen share, peer is here) ───────────────
    // FaceTime / Around pattern: when there's nothing being shared, we don't
    // want the user staring at a "nobody's sharing" card while their friend's
    // face is shrunk to a 280px sidebar tile. Make the peer the centerpiece —
    // their video fills the main canvas — and shrink the user themselves to
    // a small picture-in-self in the corner. Symmetric 50/50 grids feel empty
    // for 2-person calls; this asymmetric stack feels intimate. The SHARE
    // button moves to a floating sticker on the bottom so the actual face
    // doesn't get crowded out.
    if (peerDisplayName && remoteCameraStream) {
      return (
        <PeerLargeView
          peerStream={remoteCameraStream}
          peerName={peerDisplayName}
          peerIsMuted={!!peerIsMuted}
          peerIsCameraOff={!!peerIsCameraOff}
          localStream={localStream ?? null}
          onRequestShare={onRequestShare}
          canRequestShare={canRequestShare}
          isWaitingForApproval={isWaitingForApproval}
        />
      );
    }

    // Fall-through: no peer yet, or peer joined but no camera stream at all.
    return (
      <div
        style={{
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          border: '4px solid var(--ink)',
          borderRadius: 6,
          background: 'var(--cream)',
          boxShadow: '6px 6px 0 var(--ink)',
          position: 'relative',
          overflow: 'hidden',
        }}
      >
        {/* Faint screentone background */}
        <svg
          aria-hidden="true"
          style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', opacity: 0.25, pointerEvents: 'none' }}
        >
          <rect width="100%" height="100%" fill="url(#tone-lines)" />
        </svg>
        <div style={{ textAlign: 'center', position: 'relative', padding: 24 }}>
          <Doodle kind="tv" size={92} color="var(--purple)" />
          <p className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 12 }}>
            {peerDisplayName ? `waiting for ${peerDisplayName}'s camera…` : "nobody's here yet"}
          </p>
          <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center' }}>
            {canRequestShare && !isWaitingForApproval && (
              <StickerButton color="pink" size="md" sfx="WHRR" onClick={onRequestShare}>
                SHARE MY SCREEN
              </StickerButton>
            )}
            {isWaitingForApproval && (
              <div
                className="hand"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 10,
                  fontSize: 20,
                  color: 'var(--purple)',
                }}
              >
                <span style={{ animation: 'speakPulse 1.2s ease-in-out infinite' }}>•</span>
                waiting for approval…
              </div>
            )}
          </div>
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────────────────────── */
  /* Active screen share — the big presentation panel           */
  /* ────────────────────────────────────────────────────────── */
  return (
    <div
      ref={containerRef}
      onMouseMove={handleMouseMove}
      style={{
        height: '100%',
        position: 'relative',
        background: 'var(--ink)',
        border: '4px solid var(--ink)',
        borderRadius: 6,
        overflow: 'hidden',
        boxShadow: '8px 8px 0 var(--ink)',
      }}
    >
      <video
        ref={videoRef}
        autoPlay
        playsInline
        muted
        onDoubleClick={toggleFullscreen}
        onClick={handleScreenTap}
        style={{ width: '100%', height: '100%', objectFit: 'contain' }}
      />

      {!isLocalSharing && <audio ref={audioRef} autoPlay playsInline />}

      {/* Peer cursor halo — Figma-style multiplayer pointer. Translated
          via percent-based left/top from the normalized 0..1 coordinates
          the peer sent. pointerEvents:none so it never blocks our own
          interactions. */}
      {peerCursor && (
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: `${peerCursor.x * 100}%`,
            top: `${peerCursor.y * 100}%`,
            transform: 'translate(-6px, -6px)',
            pointerEvents: 'none',
            zIndex: 4,
            transition: 'left 80ms linear, top 80ms linear',
          }}
        >
          {/* Halo dot */}
          <div
            style={{
              width: 16,
              height: 16,
              borderRadius: 999,
              background: 'var(--orange)',
              border: '2.5px solid var(--ink)',
              boxShadow: '0 0 0 6px rgba(255, 122, 41, 0.25)',
            }}
          />
          {/* Name tag, leans 2° */}
          <div
            style={{
              position: 'absolute',
              left: 18,
              top: 14,
              padding: '1px 6px',
              background: 'var(--orange)',
              color: 'var(--ink)',
              border: '2px solid var(--ink)',
              fontFamily: 'var(--font-sfx)',
              fontSize: 11,
              letterSpacing: 0.5,
              whiteSpace: 'nowrap',
              transform: 'rotate(2deg)',
            }}
          >
            {peerCursor.name}
          </div>
        </div>
      )}

      {/* Highlighter draw-in around the perimeter. In fullscreen we drop it —
          the pink frame around shared content competes with the content itself,
          and the whole point of fullscreen is "let me focus." On mouse idle
          (overlay-hidden state) we fade it for the same reason. Faded via
          opacity so the animation isn't re-triggered when overlays come back. */}
      <svg
        aria-hidden="true"
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          opacity: isFullscreen || hideOverlay ? 0 : 1,
          transition: 'opacity 200ms ease',
        }}
        viewBox="0 0 800 450"
        preserveAspectRatio="none"
      >
        <rect
          x="6"
          y="6"
          width="788"
          height="438"
          fill="none"
          stroke="var(--pink)"
          strokeWidth="6"
          strokeDasharray="1200"
          style={{ animation: 'highlighterDraw 1.4s ease-out forwards', opacity: 0.6 }}
        />
      </svg>

      {/* Top-left badges */}
      {!hideOverlay && (
        <div
          style={{
            position: 'absolute',
            top: 12,
            left: 12,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            flexWrap: 'wrap',
          }}
        >
          {/* Sharing badge */}
          <div
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 8,
              padding: '6px 12px',
              background: 'var(--orange)',
              border: '3px solid var(--ink)',
              borderRadius: 999,
              boxShadow: '3px 3px 0 var(--ink)',
              fontFamily: 'var(--font-sfx)',
              fontSize: 14,
              letterSpacing: 1,
              color: 'var(--ink)',
              transform: 'rotate(-2deg)',
            }}
          >
            <span
              style={{
                width: 8,
                height: 8,
                background: 'var(--ink)',
                borderRadius: 999,
                animation: 'speakPulse 1.2s ease-in-out infinite',
              }}
              aria-hidden="true"
            />
            {isLocalSharing ? 'YOU ARE SHARING' : `${sharerName} IS SHARING`}
          </div>

          {/* Audio available badge */}
          {!isLocalSharing && hasAudioTrack && (
            <div
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 6,
                padding: '6px 10px',
                background: 'var(--pink)',
                border: '3px solid var(--ink)',
                borderRadius: 999,
                boxShadow: '3px 3px 0 var(--ink)',
                fontFamily: 'var(--font-sfx)',
                fontSize: 13,
                letterSpacing: 1,
                color: 'var(--ink)',
                transform: 'rotate(1deg)',
              }}
            >
              ♪ AUDIO
            </div>
          )}

          {/* Quality indicator */}
          {screenStream && (isLocalSharing ? peerQualityLevel : qualityLevel) && (
            <QualityIndicator
              level={(isLocalSharing ? peerQualityLevel : qualityLevel) ?? null}
              showLabel={false}
              size="sm"
            />
          )}
        </div>
      )}

      {/* Top-right SFX + fullscreen button */}
      {!hideOverlay && !isFullscreen && (
        <>
          <div
            style={{
              position: 'absolute',
              top: 28,
              right: 80,
              pointerEvents: 'none',
              zIndex: 3,
            }}
          >
            <SFX size={28} color="var(--cream)" tone="pink" stroke={2} angle={8}>
              FEATURE!
            </SFX>
          </div>
          <div style={{ position: 'absolute', top: 12, right: 12 }}>
            <button
              type="button"
              onClick={toggleFullscreen}
              disabled={!screenStream}
              title={!screenStream ? 'no screen to fullscreen' : 'fullscreen'}
              style={{
                width: 40,
                height: 40,
                display: 'grid',
                placeItems: 'center',
                background: 'var(--cream)',
                color: 'var(--ink)',
                border: '3px solid var(--ink)',
                borderRadius: 8,
                cursor: screenStream ? 'pointer' : 'not-allowed',
                boxShadow: '3px 3px 0 var(--ink)',
                transform: 'rotate(-3deg)',
                padding: 0,
              }}
            >
              <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                <path d="M3 8 L 3 3 L 8 3 M16 3 L 21 3 L 21 8 M21 16 L 21 21 L 16 21 M8 21 L 3 21 L 3 16" />
              </svg>
            </button>
          </div>
        </>
      )}

      {/* Remote camera PiP in fullscreen */}
      {isFullscreen && remoteCameraStream && showPeerCamera && (
        <div
          ref={pipRef}
          onMouseDown={handlePipMouseDown}
          style={{
            position: 'absolute',
            bottom: 80,
            right: 16,
            width: 200,
            height: 'auto',
            aspectRatio: '16/9',
            transform: `translate(${pipPosition.x}px, ${pipPosition.y}px) rotate(-1.5deg)`,
            cursor: isDragging ? 'grabbing' : 'grab',
            border: '3.5px solid var(--ink)',
            background: 'var(--cream)',
            boxShadow: '6px 6px 0 var(--ink)',
            overflow: 'hidden',
            userSelect: 'none',
          }}
        >
          <video
            ref={remoteCameraRef}
            autoPlay
            playsInline
            muted
            style={{ width: '100%', height: '100%', objectFit: 'cover', pointerEvents: 'none' }}
          />
          <div
            style={{
              position: 'absolute',
              left: 6,
              bottom: 6,
              background: 'var(--cream)',
              border: '2.5px solid var(--ink)',
              padding: '2px 8px',
              fontFamily: 'var(--font-sfx)',
              fontSize: 12,
              pointerEvents: 'none',
            }}
          >
            {peerDisplayName ?? 'peer'}
          </div>
        </div>
      )}

      {/* Fullscreen controls overlay */}
      {isFullscreen && (
        <div
          style={{
            position: 'absolute',
            bottom: 0,
            left: 0,
            right: 0,
            padding: 14,
            background: 'linear-gradient(to top, rgba(26,20,23,0.8), transparent)',
            opacity: hideOverlay ? 0 : 1,
            pointerEvents: hideOverlay ? 'none' : 'auto',
            transition: 'opacity .3s',
            display: 'flex',
            flexDirection: 'column',
            alignItems: 'center',
            gap: 8,
          }}
        >
          <MediaControls
            isMuted={isMuted}
            isCameraOn={isCameraOn}
            isScreenSharing={isScreenSharing}
            onToggleMute={onToggleMute}
            onToggleCamera={onToggleCamera}
            onToggleScreenShare={onToggleScreenShare}
            onLeave={onLeave}
            canShare={canShare}
            isFullscreen
            showPeerCamera={showPeerCamera}
            onTogglePeerCamera={() => setShowPeerCamera((prev) => !prev)}
            hasPeerCamera={!!remoteCameraStream}
            isSharer={isLocalSharing}
            hasPeer={!!peerDisplayName}
            peerDisplayName={peerDisplayName ?? undefined}
            hasScreenAudio={hasAudioTrack && !isLocalSharing}
            screenAudioVolume={audioVolume}
            onScreenAudioVolumeChange={handleVolumeChange}
          />
          <button
            type="button"
            onClick={toggleFullscreen}
            title="exit fullscreen (ESC)"
            style={{
              padding: '6px 16px',
              background: 'var(--cream)',
              border: '3px solid var(--ink)',
              borderRadius: 999,
              fontFamily: 'var(--font-hand)',
              fontWeight: 700,
              fontSize: 18,
              color: 'var(--ink)',
              cursor: 'pointer',
              boxShadow: '3px 3px 0 var(--ink)',
            }}
          >
            ↩ exit fullscreen
          </button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* PeerLargeView — "asymmetric stack" empty state                  */
/*                                                                 */
/* When there's a peer in the call but nobody is sharing a screen, */
/* we'd rather not stare at a "nobody's showing their screen yet"  */
/* card. The peer's face is the actual content of a 2-person call. */
/* So we use the main panel as the peer's stage and shrink the     */
/* user themselves into a tilted sticker tile in the corner —      */
/* same pattern FaceTime / Around / Discord stream use.            */
/*                                                                 */
/* The SHARE button floats over the bottom so it's still reachable */
/* without clipping the face mid-frame.                            */
/* ────────────────────────────────────────────────────────────── */

interface PeerLargeViewProps {
  peerStream: MediaStream;
  peerName: string;
  peerIsMuted: boolean;
  peerIsCameraOff: boolean;
  localStream: MediaStream | null;
  onRequestShare: () => void;
  canRequestShare: boolean;
  isWaitingForApproval: boolean;
}

function PeerLargeView({
  peerStream,
  peerName,
  peerIsMuted,
  peerIsCameraOff,
  localStream,
  onRequestShare,
  canRequestShare,
  isWaitingForApproval,
}: PeerLargeViewProps) {
  const peerVideoRef = useRef<HTMLVideoElement>(null);
  const localVideoRef = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    if (peerVideoRef.current) peerVideoRef.current.srcObject = peerStream;
  }, [peerStream]);

  useEffect(() => {
    if (localVideoRef.current) localVideoRef.current.srcObject = localStream;
  }, [localStream]);

  return (
    <div
      style={{
        position: 'relative',
        height: '100%',
        border: '4px solid var(--ink)',
        borderRadius: 6,
        background: 'var(--ink)',
        boxShadow: '8px 8px 0 var(--ink)',
        overflow: 'hidden',
      }}
    >
      {/* Peer video — fills the canvas */}
      <video
        ref={peerVideoRef}
        autoPlay
        playsInline
        muted
        style={{
          width: '100%',
          height: '100%',
          objectFit: 'cover',
          background: 'var(--cream-deep)',
          opacity: peerIsCameraOff ? 0 : 1,
          transition: 'opacity 150ms ease',
        }}
      />

      {/* Camera-off curtain — keeps the <video> mounted so it lights up
          instantly when peer flips their camera back on. */}
      {peerIsCameraOff && (
        <div
          aria-label={`${peerName}'s camera is off`}
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            background: 'var(--cream-deep)',
          }}
        >
          <div style={{ textAlign: 'center' }}>
            <Doodle kind="z" size={64} color="rgba(26,20,23,0.45)" />
            <p className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.6)', marginTop: 8 }}>
              {peerName}'s camera is off
            </p>
          </div>
        </div>
      )}

      {/* Peer name plate, top-left */}
      <div
        style={{
          position: 'absolute',
          top: 14,
          left: 14,
          padding: '6px 12px',
          background: 'var(--cream)',
          border: '3px solid var(--ink)',
          boxShadow: '3px 3px 0 var(--ink)',
          fontFamily: 'var(--font-sfx)',
          fontSize: 14,
          letterSpacing: 1,
          color: 'var(--ink)',
          transform: 'rotate(-2deg)',
        }}
      >
        {peerName}
      </div>

      {/* Mute badge, top-right */}
      {peerIsMuted && (
        <div
          aria-label={`${peerName} is muted`}
          style={{
            position: 'absolute',
            top: 14,
            right: 14,
            padding: '4px 10px',
            background: 'var(--orange)',
            border: '3px solid var(--ink)',
            boxShadow: '3px 3px 0 var(--ink)',
            fontFamily: 'var(--font-sfx)',
            fontSize: 14,
            letterSpacing: 1,
            color: 'var(--ink)',
            transform: 'rotate(3deg)',
            display: 'inline-flex',
            alignItems: 'center',
            gap: 6,
          }}
        >
          <span aria-hidden="true">🔇</span> MUTED
        </div>
      )}

      {/* Picture-in-self — bottom-right corner, mirrored, manga-tilted.
          Hidden when localStream is missing (camera permission denied
          or user explicitly stopped the camera). */}
      {localStream && (
        <div
          style={{
            position: 'absolute',
            right: 16,
            bottom: 80,
            width: 180,
            aspectRatio: '4/3',
            border: '3.5px solid var(--ink)',
            background: 'var(--cream-deep)',
            boxShadow: '5px 5px 0 var(--purple)',
            transform: 'rotate(2deg)',
            overflow: 'hidden',
            zIndex: 2,
          }}
        >
          <video
            ref={localVideoRef}
            autoPlay
            playsInline
            muted
            style={{
              width: '100%',
              height: '100%',
              objectFit: 'cover',
              transform: 'scaleX(-1)', // selfie mirror
            }}
          />
          <div
            style={{
              position: 'absolute',
              left: 6,
              bottom: 6,
              background: 'var(--cream)',
              border: '2px solid var(--ink)',
              padding: '1px 6px',
              fontFamily: 'var(--font-sfx)',
              fontSize: 11,
              letterSpacing: 1,
            }}
          >
            you
          </div>
        </div>
      )}

      {/* Share button — floating along the bottom so it doesn't crowd
          the face. Switches to a soft "waiting" message during the
          approval round-trip. */}
      <div
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          bottom: 16,
          display: 'flex',
          justifyContent: 'center',
          pointerEvents: 'none',
          zIndex: 1,
        }}
      >
        <div style={{ pointerEvents: 'auto' }}>
          {canRequestShare && !isWaitingForApproval && (
            <StickerButton color="pink" size="md" sfx="WHRR" onClick={onRequestShare}>
              SHARE MY SCREEN
            </StickerButton>
          )}
          {isWaitingForApproval && (
            <div
              className="hand"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 10,
                padding: '8px 16px',
                background: 'var(--cream)',
                border: '3px solid var(--ink)',
                boxShadow: '3px 3px 0 var(--ink)',
                fontSize: 18,
                color: 'var(--purple)',
              }}
            >
              <span style={{ animation: 'speakPulse 1.2s ease-in-out infinite' }}>•</span>
              waiting for approval…
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
