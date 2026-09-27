import { logger } from '../../services/logger';
import { useEffect, useLayoutEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { MediaControls, type MediaControlsQualityProps } from '../Controls/MediaControls';
import { QualityIndicator } from '../Quality/QualityIndicator';
import { Button, IconButton } from '../ui/Button';
import { AudioWaveIcon, ExpandIcon, MicOffIcon, ScreenIcon, ShrinkIcon } from '../ui/icons';
import { useAudioLevel } from '../../hooks/useAudioLevel';
import { canCaptureScreen } from '../../utils/capabilities';
import type { QualityLevel, Viewport } from '../../types';

/**
 * Extends the quality-and-voice props so the fullscreen control bar can be fed
 * everything the windowed one gets. Passed through untouched: this component
 * has no opinion about quality, it only owns the element that goes fullscreen.
 */
interface ScreenShareViewProps extends MediaControlsQualityProps {
  screenStream: MediaStream | null;
  isLocalSharing: boolean;
  sharerName: string | null;
  onRequestShare: () => void;
  canRequestShare: boolean;
  isWaitingForApproval: boolean;
  /** Give up on a request the peer has not answered. See the waiting chip. */
  onCancelRequest: () => void;
  isMuted: boolean;
  isCameraOn: boolean;
  isScreenSharing: boolean;
  onToggleMute: () => void;
  onToggleCamera: () => void;
  onToggleScreenShare: () => void;
  onLeave: () => void;
  canShare: boolean;
  remoteCameraStream: MediaStream | null;
  /** Local camera stream — used for the self view in the "peer-large"
   *  state (no screen share active). */
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
  /** How large the shared picture is actually being drawn here, in device
   *  pixels, or null before layout. Reported upstream so the SENDER can stop
   *  paying for pixels this screen has nowhere to put. Must be stable across
   *  renders — it drives a ResizeObserver. */
  onViewportChange?: (viewport: Viewport | null) => void;
  /** Build and show the debug report. Passed through to the fullscreen controls. */
  onDebugReport?: () => void;
  /** What to show while nobody else is here — the room's invite card. */
  waitingSlot?: ReactNode;
}

export function ScreenShareView({
  screenStream,
  isLocalSharing,
  sharerName,
  onRequestShare,
  canRequestShare,
  isWaitingForApproval,
  onCancelRequest,
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
  onViewportChange,
  onDebugReport,
  waitingSlot,
  screenShareQuality,
  onQualityChange,
  uplink,
  diagnostics,
  appliedPoint,
  atBudgetFloor,
  inbound,
  peerShare,
  contentMode,
  onContentModeChange,
  peerVolume,
  onPeerVolumeChange,
}: ScreenShareViewProps) {
  /*
   * The screen <video> is tracked twice on purpose: a ref to write through,
   * and a piece of state that says whether it exists yet.
   *
   * It does not exist for most of this component's life. The empty state below
   * returns early and that branch has no <video> in it, so the element mounts
   * on a *later* commit than the component — and a ref does not re-run an
   * effect when its element finally appears. That is not theoretical: the
   * viewport effect below read the ref once on mount, found null, bailed, and
   * never attached its ResizeObserver. `onViewportChange` was therefore never
   * called, not even after the share started, and every debug report since the
   * feature shipped has read "no viewport reported" for that reason alone —
   * leaving the sender to fall back on a conservative guess at a viewer size
   * it was in fact being told nothing about.
   *
   * A callback ref fires with the element on mount and with null on unmount,
   * so routing it through state gives both effects below an edge to run on.
   * srcObject keeps going through the ref: that is a write to the DOM node,
   * and state is meant to be read, not mutated.
   */
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [videoEl, setVideoEl] = useState<HTMLVideoElement | null>(null);
  const attachVideo = useCallback((el: HTMLVideoElement | null) => {
    videoRef.current = el;
    setVideoEl(el);
  }, []);
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
  }, [screenStream, videoEl]);

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

  /*
   * Tell the sender how big we are actually drawing their screen.
   *
   * The element box rather than the drawn rectangle, even though objectFit is
   * 'contain' and letterboxes: every resolution the sender will offer is 16:9
   * and it bounds width AND height, so a 1920x900 window correctly resolves to
   * 1600x900 without us having to know the source aspect ratio here.
   *
   * devicePixelRatio because a 960 CSS-pixel element on a Retina display has
   * 1920 real pixels to fill, and real pixels are what the question is about.
   *
   * A ResizeObserver rather than a resize listener so this also catches
   * fullscreen, sidebar toggles and layout changes — the moments when the
   * answer changes most.
   */
  useEffect(() => {
    const el = videoEl;
    if (!el || !onViewportChange) return;

    const report = () => {
      const rect = el.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      const width = Math.round(rect.width * dpr);
      const height = Math.round(rect.height * dpr);
      // Before layout the box is 0x0. Null — no opinion — rather than a zero
      // that would collapse the sender's resolution box to nothing.
      onViewportChange(width > 0 && height > 0 ? { width, height } : null);
    };

    report();
    const observer = new ResizeObserver(report);
    observer.observe(el);
    return () => observer.disconnect();
  }, [onViewportChange, videoEl]);

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

  /* The waiting chip is a button, not a label. Waiting used to be a dead
     end: it disabled every other way back to sharing, so a request the peer
     never answered could only be escaped by leaving the session. */
  const approvalChip = (
    <AnimatePresence>
      {isWaitingForApproval && (
        <m.div
          className="approval-chip"
          role="status"
          initial={{ opacity: 0, y: -12, scale: 0.95 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          exit={{ opacity: 0, y: -8 }}
        >
          <span className="chip__dot" data-live="" aria-hidden="true" />
          <span>Waiting for {peerDisplayName ?? 'them'} to allow your screen</span>
          <Button size="sm" variant="ghost" onClick={onCancelRequest}>
            Cancel
          </Button>
        </m.div>
      )}
    </AnimatePresence>
  );

  /* ────────────────────────────────────────────────────────── */
  /* Nobody is sharing                                          */
  /* ────────────────────────────────────────────────────────── */
  if (!screenStream && !sharerName) {
    // FaceTime / Around pattern: when there's nothing being shared, the
    // other person IS the picture. You shrink to a small window you can park
    // in any corner.
    if (!peerHasLeft && peerDisplayName && remoteCameraStream) {
      return (
        <PeerLargeView
          peerStream={remoteCameraStream}
          peerName={peerDisplayName}
          peerIsMuted={!!peerIsMuted}
          peerIsCameraOff={!!peerIsCameraOff}
          localStream={localStream ?? null}
          approvalChip={approvalChip}
        />
      );
    }

    const shareButton =
      canRequestShare && !isWaitingForApproval && canCaptureScreen() ? (
        <Button variant="secondary" icon={<ScreenIcon size={18} />} onClick={onRequestShare}>
          Share your screen
        </Button>
      ) : null;

    return (
      <div className="stage">
        {approvalChip}
        <div className="stage__empty">
          <m.div
            className="stage__empty-inner"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.5 }}
          >
            {peerHasLeft ? (
              <>
                <h2>They left</h2>
                <p>The session is still open. Send a new invite to bring someone back.</p>
                {waitingSlot}
              </>
            ) : peerDisplayName ? (
              <>
                <span className="avatar" data-who="them" style={{ ['--av' as string]: '72px' }} aria-hidden="true">
                  {peerDisplayName.charAt(0).toUpperCase()}
                </span>
                <h2>{peerDisplayName} is here</h2>
                <p>Waiting for their camera. Their voice may already be coming through.</p>
              </>
            ) : (
              waitingSlot
            )}
            {shareButton}
          </m.div>
        </div>
      </div>
    );
  }

  /* ────────────────────────────────────────────────────────── */
  /* A screen is being shared                                   */
  /* ────────────────────────────────────────────────────────── */
  const indicatorLevel = (isLocalSharing ? peerQualityLevel : qualityLevel) ?? null;

  return (
    <div ref={containerRef} className="stage stage--share" onMouseMove={handleMouseMove}>
      <video
        ref={attachVideo}
        data-ambient=""
        autoPlay
        playsInline
        muted
        onDoubleClick={toggleFullscreen}
        onClick={handleScreenTap}
      />

      {!isLocalSharing && <audio ref={audioRef} autoPlay playsInline />}

      {/* The lamp coming up on a new reel. Keyed on the sharer so a second
          share gets its own flash. */}
      <m.div
        key={sharerName ?? 'share'}
        className="stage__flash"
        aria-hidden="true"
        initial={{ opacity: 0.9 }}
        animate={{ opacity: 0 }}
        transition={{ duration: 1.1, ease: [0.22, 1, 0.36, 1] }}
      />

      {/* The other person's pointer over the shared content — their light.
          Normalized coordinates, projected onto our own box. */}
      {peerCursor && (
        <div
          className="cursor"
          aria-hidden="true"
          style={{ left: `${peerCursor.x * 100}%`, top: `${peerCursor.y * 100}%` }}
        >
          <div className="cursor__dot" />
          <div className="cursor__name">{peerCursor.name}</div>
        </div>
      )}

      {!hideOverlay && (
        <div className="stage__chips">
          <span className="chip chip--glass">
            <span className="chip__dot" data-live="" style={{ color: 'var(--exit)' }} aria-hidden="true" />
            {isLocalSharing ? 'You’re sharing your screen' : `${sharerName} is sharing`}
          </span>
          {!isLocalSharing && hasAudioTrack && (
            <span className="chip chip--glass">
              <AudioWaveIcon size={15} />
              Audio
            </span>
          )}
          {screenStream && indicatorLevel && <QualityIndicator level={indicatorLevel} />}
        </div>
      )}

      {!hideOverlay && !isFullscreen && (
        <div className="stage__corner">
          <IconButton
            label={!screenStream ? 'No screen to show fullscreen' : 'Fullscreen'}
            size="sm"
            tip="below"
            onClick={toggleFullscreen}
            disabled={!screenStream}
          >
            <ExpandIcon size={17} />
          </IconButton>
        </div>
      )}

      {/* Their camera, floating over the share in fullscreen. */}
      {isFullscreen && remoteCameraStream && showPeerCamera && (
        <div
          ref={pipRef}
          className="fs-pip"
          onMouseDown={handlePipMouseDown}
          style={{
            transform: `translate(${pipPosition.x}px, ${pipPosition.y}px)`,
            cursor: isDragging ? 'grabbing' : 'grab',
          }}
        >
          <video ref={remoteCameraRef} autoPlay playsInline muted />
          <span className="chip chip--glass tile__name">{peerDisplayName ?? 'Them'}</span>
        </div>
      )}

      {/* Fullscreen controls overlay */}
      {isFullscreen && (
        <div className="fs-controls" data-hidden={hideOverlay ? '' : undefined}>
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
            onDebugReport={onDebugReport}
            screenShareQuality={screenShareQuality}
            onQualityChange={onQualityChange}
            uplink={uplink}
            diagnostics={diagnostics}
            appliedPoint={appliedPoint}
            atBudgetFloor={atBudgetFloor}
            inbound={inbound}
            peerShare={peerShare}
            contentMode={contentMode}
            onContentModeChange={onContentModeChange}
            peerVolume={peerVolume}
            onPeerVolumeChange={onPeerVolumeChange}
          />
          <Button size="sm" variant="secondary" icon={<ShrinkIcon size={16} />} onClick={toggleFullscreen}>
            Exit fullscreen
          </Button>
        </div>
      )}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* PeerLargeView — the other person, filling the stage            */
/* ────────────────────────────────────────────────────────────── */

interface PeerLargeViewProps {
  peerStream: MediaStream;
  peerName: string;
  peerIsMuted: boolean;
  peerIsCameraOff: boolean;
  localStream: MediaStream | null;
  approvalChip: ReactNode;
}

function PeerLargeView({ peerStream, peerName, peerIsMuted, peerIsCameraOff, localStream, approvalChip }: PeerLargeViewProps) {
  const peerVideoRef = useRef<HTMLVideoElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  // Their voice lights the frame.
  useAudioLevel(peerStream, stageRef);

  useEffect(() => {
    if (peerVideoRef.current) peerVideoRef.current.srcObject = peerStream;
  }, [peerStream]);

  return (
    <div className="stage stage--peer" ref={stageRef}>
      <video
        ref={peerVideoRef}
        data-ambient=""
        autoPlay
        playsInline
        muted
        style={{ opacity: peerIsCameraOff ? 0 : 1, transition: 'opacity 200ms ease' }}
      />

      {/* Camera-off state — keeps the <video> mounted so it lights up
          instantly when they flip their camera back on. */}
      <AnimatePresence>
        {peerIsCameraOff && (
          <m.div
            className="stage__off"
            aria-label={`${peerName}'s camera is off`}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
          >
            <span className="avatar" data-who="them" aria-hidden="true">
              {peerName.charAt(0).toUpperCase()}
            </span>
            <span>{peerName}’s camera is off</span>
          </m.div>
        )}
      </AnimatePresence>

      {approvalChip}

      <span className="chip chip--glass stage__name">{peerName}</span>

      {peerIsMuted && (
        <span className="chip chip--exit stage__muted" aria-label={`${peerName} is muted`}>
          <MicOffIcon size={14} />
          Muted
        </span>
      )}

      {localStream && <SelfView stream={localStream} boundsRef={stageRef} />}
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* SelfView — you, in a corner you can move                       */
/* ────────────────────────────────────────────────────────────── */

type Corner = 'tl' | 'tr' | 'bl' | 'br';
const CORNER_KEY = 'wt:selfview:corner';

/** Animate an element from an offset back to where CSS now puts it. */
function glide(el: HTMLElement, dx: number, dy: number) {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'translate(0, 0)' }], {
    duration: 560,
    easing: 'cubic-bezier(0.34, 1.4, 0.64, 1)',
  });
}

function readCorner(): Corner {
  try {
    const saved = window.localStorage.getItem(CORNER_KEY);
    if (saved === 'tl' || saved === 'tr' || saved === 'bl' || saved === 'br') return saved;
  } catch {
    // Storage can be unavailable; the default corner is fine.
  }
  return 'br';
}

/**
 * Your own camera, small, mirrored — draggable anywhere, and on release it
 * glides to the nearest corner and stays there next time.
 *
 * The glide is a FLIP: measure where it was dropped, switch the corner in
 * CSS, measure where that put it, then animate the difference away. Built on
 * pointer events and the Web Animations API, so it works the same for a
 * mouse and a finger and needs nothing from React per frame.
 */
function SelfView({ stream, boundsRef }: { stream: MediaStream; boundsRef: React.RefObject<HTMLDivElement | null> }) {
  const [corner, setCorner] = useState<Corner>(readCorner);
  const elRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const drag = useRef<{ id: number; x: number; y: number; moved: boolean } | null>(null);
  const flipFrom = useRef<DOMRect | null>(null);
  const [dragging, setDragging] = useState(false);

  // Your voice lights your frame.
  useAudioLevel(stream, elRef);

  useEffect(() => {
    if (videoRef.current) videoRef.current.srcObject = stream;
  }, [stream]);

  useLayoutEffect(() => {
    const el = elRef.current;
    const from = flipFrom.current;
    if (!el || !from) return;
    flipFrom.current = null;
    const to = el.getBoundingClientRect();
    glide(el, from.left - to.left, from.top - to.top);
  }, [corner]);

  const onPointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    drag.current = { id: e.pointerId, x: e.clientX, y: e.clientY, moved: false };
  };

  const onPointerMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d || d.id !== e.pointerId) return;
    const dx = e.clientX - d.x;
    const dy = e.clientY - d.y;
    if (!d.moved && Math.hypot(dx, dy) < 4) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(true);
    }
    e.currentTarget.style.translate = `${dx}px ${dy}px`;
  };

  const onPointerUp = (e: React.PointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    const el = elRef.current;
    const bounds = boundsRef.current;
    drag.current = null;
    if (!d || !el || !bounds || !d.moved) return;
    setDragging(false);

    const rect = el.getBoundingClientRect();
    const b = bounds.getBoundingClientRect();
    const cx = rect.left + rect.width / 2 - b.left;
    const cy = rect.top + rect.height / 2 - b.top;
    const next: Corner = `${cy < b.height / 2 ? 't' : 'b'}${cx < b.width / 2 ? 'l' : 'r'}` as Corner;

    el.style.translate = '';
    if (next === corner) {
      const home = el.getBoundingClientRect();
      glide(el, rect.left - home.left, rect.top - home.top);
    } else {
      flipFrom.current = rect;
      setCorner(next);
      try {
        window.localStorage.setItem(CORNER_KEY, next);
      } catch {
        // Not remembered; still moved.
      }
    }
    e.currentTarget.releasePointerCapture?.(e.pointerId);
  };

  return (
    <div
      ref={elRef}
      className="selfview"
      data-corner={corner}
      data-dragging={dragging ? '' : undefined}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerCancel={onPointerUp}
      title="Drag to move"
    >
      <video ref={videoRef} autoPlay playsInline muted />
      <span className="chip chip--glass selfview__label">You</span>
    </div>
  );
}
