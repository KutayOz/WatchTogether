import { logger } from '../../services/logger';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import { useNavigate, useParams, useLocation } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { useSessionContext } from '../../context/SessionContext';
import { useTransport } from '../../hooks/useTransport';
import { useWebRTC } from '../../hooks/useWebRTC';
import { useMediaDevices } from '../../hooks/useMediaDevices';
import { useUplinkEstimate } from '../../hooks/useUplinkEstimate';
import { useTransportDiagnostics } from '../../hooks/useTransportDiagnostics';
import { shouldDowngradeCodec, useSenderHealth } from '../../hooks/useSenderHealth';
import {
  chooseOperatingPoint,
  coldStartBudgetBps,
  initialBudgetState,
  minVideoBps,
  nextBudget,
  type BudgetState,
  sameOperatingPoint,
  sameViewport,
  type OperatingPoint,
} from '../../hooks/operatingPoint';
import {
  initialCapacityState,
  nextCapacity,
  type CapacityState,
} from '../../hooks/encodeCapacity';
import { HEADROOM_SELECT } from '../../hooks/useUplinkEstimate';
import {
  currentViewerLevel,
  currentViewerPicture,
  currentViewerViewport,
  viewerIsStarved,
  viewerIsUnhappy,
  type ViewerReport,
} from '../../hooks/qualityLadder';
import { useQualityMonitor } from '../../hooks/useQualityMonitor';
import { useDiagnosticsRecorder } from '../../hooks/useDiagnosticsRecorder';
import { formatDiagnosticsReport } from '../../hooks/diagnosticsReport';
import { DebugReportModal } from './DebugReportModal';
import { logBuffer } from '../../services/logBuffer';
import { formatIceDiagnostics, webrtcService } from '../../services/webrtcService';
import { useTalkingWhileMuted } from '../../hooks/useTalkingWhileMuted';
import { api } from '../../services/api';
import { Sidebar } from './Sidebar';
import { ScreenShareView } from './ScreenShareView';
import { ScreenShareRequest } from './ScreenShareRequest';
import { FullscreenPortal } from '../common/FullscreenPortal';
import type { MediaControlsQualityProps } from '../Controls/MediaControls';
import { PreflightLobby, type PreflightInitialState } from './PreflightLobby';
import { ConnectionQualityBadge } from './ConnectionQualityBadge';
import { KeyboardShortcutsModal } from './KeyboardShortcutsModal';
import { WatchTogetherPlayer, extractYouTubeVideoId } from './WatchTogetherPlayer';
import { useKeyboardShortcuts } from '../../hooks/useKeyboardShortcuts';
import { useBackgroundBlur } from '../../hooks/useBackgroundBlur';
import { useResizableSidebar } from '../../hooks/useResizableSidebar';
import { useInviteLink } from '../../hooks/useInviteLink';
import { useWatchTogether } from '../../hooks/useWatchTogether';
import { usePeerPresence } from '../../hooks/usePeerPresence';
import { MediaControls, type DockMenuItem } from '../Controls/MediaControls';
import { Toast } from '../common/Toast';
import { AnimatePresence, m } from 'motion/react';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { Modal } from '../ui/Modal';
import { Lights } from '../ui/Lights';
import { FilmLeader } from '../ui/FilmLeader';
import { ScrambleText } from '../ui/ScrambleText';
import { AlertIcon, BlurIcon, CheckIcon, CopyIcon, KeyboardIcon, LinkIcon, PlayIcon, RefreshIcon } from '../ui/icons';
import { sparkle } from '../ui/interactions';
import { ease } from '../ui/motion';
import { useScene } from '../ui/useScene';
import { useAmbientLight } from '../../hooks/useAmbientLight';
import type { FloatingReaction as FloatingReactionData } from '../../hooks/usePeerPresence';
import './session.css';
import type {
  MediaState,
  ScreenShareQuality,
  QualityFeedback,
  ContentMode,
  Viewport,
  OutboundScreenStats,
  ShareStatus,
} from '../../types';
import { QUALITY_PRESETS, isContentMode, isScreenShareQuality } from '../../types';

export function SessionRoom() {
  const { id: urlSessionId } = useParams<{ id: string }>();
  const navigate = useNavigate();
  // Display only — it picks the wording of the lobby's context hint. The
  // negotiation role used to be read from here too, which is exactly why a
  // refresh broke calls; that now comes from the server's Joined frame, and
  // this being wrong after a refresh costs nothing but a slightly off label.
  const location = useLocation();
  const isCreator = (location.state as { isCreator?: boolean })?.isCreator ?? false;
  const { user } = useAuthContext();
  const {
    sessionId,
    peerName,
    peerHasLeft,
    screenShareRequest,
    currentScreenSharer,
    peerMediaState,
    setSessionId,
    setPeerName,
    setPeerMediaState,
    setPeerHasLeft,
    addMessage,
    clearMessages,
    setScreenShareRequest,
    setCurrentScreenSharer,
  } = useSessionContext();

  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isWaitingForApproval, setIsWaitingForApproval] = useState(false);
  /**
   * How long to wait on a peer's answer before giving the button back.
   *
   * Generous, because the peer is a person reading a modal — but finite,
   * because the alternative is what this fixes: an unanswered request disabled
   * every path back to sharing, in every surface, with no cancel and no expiry,
   * and the session had to be abandoned.
   */
  const SCREEN_SHARE_REQUEST_TIMEOUT_MS = 30_000;
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'warning' } | null>(null);
  // Docked and open on a desk-sized screen; on anything narrower the panel is
  // a drawer over the stage, so it starts closed and the picture gets the room.
  const [isSidebarOpen, setIsSidebarOpen] = useState(
    () => typeof window === 'undefined' || window.matchMedia('(min-width: 1024px)').matches,
  );

  // Stage gate. Mount lands here; PreflightLobby renders until the user
  // grants device permission and clicks JOIN, then we flip to 'joining'
  // (the existing async session-join flow) and finally 'live' once sessionId
  // is set. Routing back to lobby cancels and unmounts this whole component,
  // so we don't need an explicit reset path.
  const [stage, setStage] = useState<'preflight' | 'joining' | 'live'>('preflight');

  // In the call the room goes dark and the grain stops: the picture is the
  // only thing that should be moving.
  useScene(stage === 'live' ? 'room' : 'theater');

  // The stage throws the colours of whatever is playing onto the room.
  const stageWrapRef = useRef<HTMLDivElement>(null);
  useAmbientLight(stageWrapRef, stage === 'live');

  /**
   * The user's quality CEILING, not the operating point.
   *
   * Read from a new key. The old 'screenShareQuality' value cannot be trusted
   * and cannot be repaired: three different code paths wrote it — an explicit
   * pick, a proactive bandwidth clamp, and a reactive auto-downgrade — and
   * nothing recorded which. A value of 'low' might mean "I chose this" or might
   * mean "one bad three-second window pinned me here, permanently, on a link
   * that was fine". Since only the first is worth keeping and they are
   * indistinguishable, the honest migration is to discard and start clean.
   *
   * Default 'auto': up to 1080p, with the actual numbers coming from the
   * measured link via chooseOperatingPoint.
   */
  const [screenShareQuality, setScreenShareQuality] = useState<ScreenShareQuality>(() => {
    if (typeof window === 'undefined') return 'auto';
    const saved = window.localStorage.getItem('wt:screenShareQuality');
    if (saved === null) {
      // First run under the new scheme — clear the untrustworthy old key so a
      // stuck user is unstuck rather than inheriting the pin.
      window.localStorage.removeItem('screenShareQuality');
      return 'auto';
    }
    return isScreenShareQuality(saved) ? saved : 'auto';
  });

  /**
   * What is on the screen, which is really a frame-rate decision — and the
   * cheapest quality lever available. Film is 24 fps at source; encoding it at
   * 30 divides the same budget across 25% more frames for nothing.
   */
  const [contentMode, setContentMode] = useState<ContentMode>(() => {
    if (typeof window === 'undefined') return 'film';
    const saved = window.localStorage.getItem('wt:contentMode');
    return isContentMode(saved) ? saved : 'film';
  });

  const [peerQualityFeedback, setPeerQualityFeedback] = useState<QualityFeedback | null>(null);

  const [hasScreenAudio, setHasScreenAudio] = useState(false);
  const [screenAudioVolume, setScreenAudioVolume] = useState(100);
  const [peerVolume, setPeerVolume] = useState(100);

  // Resizable + persisted desktop sidebar width + drag interaction.
  const { sidebarWidth, isResizingSidebar, handleSidebarResizeStart, SIDEBAR_MIN, SIDEBAR_MAX } =
    useResizableSidebar();
  const [showCheatSheet, setShowCheatSheet] = useState(false);

  // Background blur — persisted toggle. The actual pipeline lives below
  // the webrtc declaration so we can read cameraTrack from it. Only the
  // PERSIST effect lives here at the state-declaration level.
  const [bgBlurEnabled, setBgBlurEnabled] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.localStorage.getItem('wt:bgblur') === '1';
  });
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('wt:bgblur', bgBlurEnabled ? '1' : '0');
  }, [bgBlurEnabled]);

  // Unread chat counter — bumps on new peer messages while sidebar is
  // collapsed, resets on open. Bound to the mobile-toggle FAB so users
  // who collapsed the sidebar still notice fresh chat.
  const [unreadMessages, setUnreadMessages] = useState(0);

  // Mirror isSidebarOpen into a ref so the transport handler — which keeps
  // its first-mount closure — sees the current value when deciding to
  // bump the unread counter.
  const isSidebarOpenRef = useRef(isSidebarOpen);
  useEffect(() => {
    isSidebarOpenRef.current = isSidebarOpen;
    // Opening the sidebar marks chat as seen.
    if (isSidebarOpen) setUnreadMessages(0);
  }, [isSidebarOpen]);

  // UI connection state — friendlier projection of the raw RTCPeerConnectionState.
  // Why not show the raw value: 'disconnected' often resolves itself in 1-2 s as
  // ICE finds a new candidate. Flashing a "DISCONNECTED" banner during a
  // half-second hiccup is just flicker. So we debounce it: only after 2.5 s of
  // continuous 'disconnected' do we promote to 'reconnecting' and show the
  // overlay. 'failed' bypasses the debounce — it means ICE has given up.
  const [uiConnState, setUiConnState] = useState<
    'idle' | 'connecting' | 'connected' | 'reconnecting' | 'lost'
  >('idle');

  const pendingScreenShareRef = useRef<{ stream: MediaStream; streamId: string } | null>(null);

  // Who creates the offer. Both of these now come from the server's Joined
  // frame rather than from React Router's location.state, which is the fix for
  // a real bug: refreshing mid-call lost the router state, so both peers came
  // back as answerers and sat waiting for an offer neither would send.
  const isInitiatorRef = useRef(false);
  // Perfect-negotiation role: the answerer is "polite" and yields on offer
  // glare; the offerer is "impolite" and ignores the colliding offer.
  const politeRef = useRef(false);
  const sessionIdRef = useRef<string | null>(null);
  const transportRef = useRef<ReturnType<typeof useTransport> | null>(null);
  const peerNameRef = useRef<string | null>(null);
  const localScreenStreamIdRef = useRef<string | null>(null);
  // Latest viewer verdict, fed into the bandwidth controller. A ref
  // because it arrives on the data channel between renders and must not itself
  // trigger one. Stamped, and read through currentViewerLevel, so a peer that
  // stops reporting cannot hold quality down for the rest of the session.
  const viewerReportRef = useRef<ViewerReport | null>(null);

  /**
   * What the SHARER says their encoder is doing, or null when nobody has said.
   *
   * State rather than a ref because both consumers render from it: the quality
   * monitor's fps yardstick and the diagnostics panel. Cleared when the share
   * ends, on the same argument as the viewer report — a status that outlives a
   * share is by definition about the last one.
   */
  const [peerShareStatus, setPeerShareStatus] = useState<ShareStatus | null>(null);

  /** The debug report, built when it is asked for and shown until dismissed. */
  const [debugReport, setDebugReport] = useState<string | null>(null);
  // Our own size as a VIEWER, measured by ScreenShareView and sent to whoever
  // is sharing. A ref for the same reason: a ResizeObserver firing must not
  // re-render the whole room.
  const myViewportRef = useRef<Viewport | null>(null);
  const handleViewportChange = useCallback((viewport: Viewport | null) => {
    myViewportRef.current = viewport;
  }, []);

  /**
   * Whether this connection's bandwidth estimate has ever meant anything.
   *
   * Latched from the uplink estimate rather than read live, because the one
   * moment it is needed — a share starting — is the one moment `uplink` is
   * null: its sample window resets on exactly that transition (see
   * useUplinkEstimate's resetKey). The camera-only phase before the share has
   * been polling the same peer connection for as long as the call has been up,
   * so the answer is already known by then; it just has to survive the reset.
   *
   * State and not a ref, and that distinction is the whole point. It has to
   * re-seed the idle budget the moment the path reveals itself, because the
   * cold start is consumed BEFORE `isScreenSharing` ever turns true:
   * `handleStartScreenShare` passes the current operating point straight to
   * `captureScreen`, so a budget corrected on the way into a share would open
   * the capturer at a size the encoder was about to be told it could not
   * afford — which is its own failure, since the capturer is then held there by
   * CAPTURE_RECONFIG_MIN_MS. Re-seeding while still idle means the point handed
   * to getDisplayMedia is already the right one.
   *
   * Defaults to true, i.e. to the generous cold start, so a call that starts
   * sharing before any estimate exists behaves exactly as it always did.
   */
  const [capacityMeasurable, setCapacityMeasurable] = useState(true);

  const { isMuted, isCameraOn, toggleMute, toggleCamera } = useMediaDevices();

  const handleIceCandidate = useCallback(async (candidate: string) => {
    const currentSessionId = sessionIdRef.current;
    const currentTransport = transportRef.current;
    if (currentSessionId && currentTransport) {
      try {
        await currentTransport.sendIceCandidate(currentSessionId, candidate);
      } catch (err) {
        logger.error('[WebRTC] Failed to send ICE candidate:', err);
      }
    } else {
      logger.warn('[WebRTC] Cannot send ICE - no session or transport', {
        hasSession: !!currentSessionId,
        hasTransport: !!currentTransport,
      });
    }
  }, []);

  const webrtcRef = useRef<ReturnType<typeof useWebRTC> | null>(null);

  const handleIceRestart = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    const currentTransport = transportRef.current;
    const currentWebrtc = webrtcRef.current;
    if (currentSessionId && currentTransport && currentWebrtc) {
      try {
        const offer = await currentWebrtc.createIceRestartOffer();
        await currentTransport.sendRenegotiationOffer(currentSessionId, offer);
      } catch (err) {
        logger.error('[Session] ICE restart failed:', err);
      }
    }
  }, []);

  /**
   * The browser's own "Stop sharing" bar, routed into the app's stop path.
   *
   * Through a ref because handleStopScreenShare is defined further down the
   * component and this callback has to be stable: useWebRTC's initialize lists
   * it as a dependency, and a fresh function every render would rebuild the
   * peer connection on every render.
   */
  const handleStopScreenShareRef = useRef<(() => Promise<void>) | null>(null);
  const handleScreenShareEnded = useCallback(() => {
    void handleStopScreenShareRef.current?.();
  }, []);

  const webrtc = useWebRTC({
    onIceCandidate: handleIceCandidate,
    onIceRestart: handleIceRestart,
    onScreenShareEnded: handleScreenShareEnded,
  });

  useEffect(() => {
    webrtcRef.current = webrtc;
  }, [webrtc]);

  /**
   * Offer.
   *
   * One path for all four ways a peer can appear: they join, we join and find
   * them already there, they refresh, we refresh. Only the offerer acts, so it
   * is safe to call unconditionally.
   *
   * Media state deliberately does NOT belong here. It used to, and that was a
   * bug: the answering side returns early and so never told the peer whether
   * its mic was on. sendMediaState covers both roles — and for the same reason
   * the screen-share re-announce that used to live here now lives in
   * declareScreenShareState, which the answering side also reaches.
   */
  const offerToPeer = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!isInitiatorRef.current || !currentSessionId) return;

    try {
      const offer = await webrtc.createOffer();
      await transportRef.current?.sendOffer(currentSessionId, offer);
    } catch (err) {
      logger.error('[transport] Failed to create/send offer:', err);
    }
  }, [webrtc]);

  /**
   * Abandon a share we asked for and never got an answer to.
   *
   * One helper because every way out of "waiting for approval" has to do the
   * same three things, and the old code did them in only two of the several
   * places that could reach this state. The capture is the reason it matters:
   * pendingScreenShareRef holds a LIVE getDisplayMedia stream, so a request
   * left hanging keeps the operating system's "you are sharing your screen"
   * indicator lit over a share nobody is watching.
   */
  const cancelPendingScreenShare = useCallback((message: string | null) => {
    const pending = pendingScreenShareRef.current;
    if (pending) {
      pending.stream.getTracks().forEach((t) => t.stop());
      pendingScreenShareRef.current = null;
    }
    setIsWaitingForApproval(false);
    if (message) setToast({ message, type: 'warning' });
  }, []);

  /**
   * Say what we are doing with our screen, whether or not that is anything.
   *
   * Sent on every event that means "somebody's picture of this room may be out
   * of date" — we rejoined, they joined, they rejoined. The negative case is
   * the load-bearing one: a share that ended while the socket was down is a
   * share the peer still believes in, and only an explicit ss:stop retires it.
   *
   * Safe to send from a peer who is not sharing: the receiving side only clears
   * on a stop whose name matches the sharer it has on record.
   */
  const declareScreenShareState = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!currentSessionId) return;

    try {
      const streamId = localScreenStreamIdRef.current;
      if (streamId) {
        await transportRef.current?.notifyScreenShareStarted(currentSessionId, streamId);
      } else {
        await transportRef.current?.stopScreenShare(currentSessionId);
      }
    } catch (err) {
      logger.error('[transport] Failed to declare screen-share state:', err);
    }
  }, []);

  // Background blur pipeline lives here (after webrtc so cameraTrack is in
  // scope). useBackgroundBlur returns outputTrack === sourceTrack when
  // disabled — no overhead. Whenever the output changes, push it into
  // the peer connection's video sender via replaceVideoTrack — same SSRC,
  // no renegotiation.
  const cameraTrack = webrtc.localStream?.getVideoTracks()[0] ?? null;
  const blur = useBackgroundBlur({ sourceTrack: cameraTrack, enabled: bgBlurEnabled });
  useEffect(() => {
    if (!blur.outputTrack) return;
    webrtc.replaceVideoTrack(blur.outputTrack);
  }, [blur.outputTrack, webrtc]);
  const lastBlurErrorRef = useRef<string | null>(null);
  useEffect(() => {
    if (blur.error && blur.error !== lastBlurErrorRef.current) {
      lastBlurErrorRef.current = blur.error;
      setToast({ message: 'blur unavailable — falling back without it', type: 'warning' });
    }
  }, [blur.error]);

  // Derive UI connection state from the raw RTCPeerConnectionState. The only
  // tricky bit is the 'disconnected' debounce: most disconnects last under a
  // second and resolve on their own. We only commit to the 'reconnecting' UI
  // after 2.5 s of continuous disconnect — long enough to filter ambient
  // hiccups, short enough that the user notices when something's actually
  // wrong. 'failed' / 'closed' bypass the debounce and go straight to 'lost'.
  useEffect(() => {
    const raw = webrtc.connectionState;
    let pending: number | undefined;

    if (raw === 'connected') {
      setUiConnState('connected');
    } else if (raw === 'failed' || raw === 'closed') {
      setUiConnState('lost');
    } else if (raw === 'connecting' || raw === 'new') {
      setUiConnState(peerName ? 'connecting' : 'idle');
    } else if (raw === 'disconnected') {
      pending = window.setTimeout(() => setUiConnState('reconnecting'), 2500);
    }

    return () => {
      if (pending !== undefined) window.clearTimeout(pending);
    };
  }, [webrtc.connectionState, peerName]);

  // "You're on mute" detector. Hook samples RMS on the LOCAL mic track even
  // when isMuted=true (track.enabled=false still captures samples, just
  // suppresses transmission), so we can catch the universal gaffe of
  // monologuing into a muted mic.
  //
  // ⬇ TUNE THESE for the feel you want. The reference ranges live in
  // useTalkingWhileMuted.ts JSDoc. Quick legend:
  //   rmsThreshold  : higher = misses quiet talkers, lower = false-fires on cough
  //   minDurationMs : how long they have to talk before the toast appears
  //   cooldownMs    : minimum gap between two warnings — don't be that app
  useTalkingWhileMuted({
    localStream: webrtc.localStream,
    isMuted,
    onDetected: () => setToast({
      message: "you're on mute — they can't hear you ♥",
      type: 'warning',
    }),
    rmsThreshold: 0.05,   // <-- 0.02 (sensitive) … 0.15 (loud-only)
    minDurationMs: 500,   // <-- 300 (snappy) … 1000 (only catch full sentences)
    cooldownMs: 30000,    // <-- 10_000 (chatty) … 60_000 (chill)
  });

  // Invite link state + generate/copy/expiry-countdown. Placed after
  // sessionIdRef (read inside) and before useTransport (onPeerLeft clears it).
  const {
    inviteUrl, isGeneratingInvite, inviteCopied,
    setInviteUrl, setInviteExpiry, handleGenerateInvite, handleCopyInvite, getInviteTimeRemaining,
  } = useInviteLink(sessionIdRef, setToast);

  // Watch Together co-watch state + local→peer sync senders. Receive side lives
  // in the central transport handler below (writes setWatchVideoId / watchPlayerRef).
  const {
    watchVideoId, setWatchVideoId, showWatchPrompt, setShowWatchPrompt,
    watchPlayerRef, handleStartWatch, handleCloseWatch, handleLocalVideoAction,
  } = useWatchTogether(sessionIdRef, transportRef, setToast);

  // Ephemeral peer presence: cursor halo, typing indicator, floating reactions.
  // Receive side lives in the central transport handler (drives the setters).
  const {
    peerCursor, setPeerCursor, handleLocalCursor,
    peerTypingName, isPeerTyping, setPeerTypingAt, setPeerTypingName, handleLocalTyping,
    reactions, setReactions, handleSendReaction,
  } = usePeerPresence(sessionIdRef, transportRef, user?.username);

  // One sender for "tell the peer what our mic / camera / screen state is."
  // Callers pass the mic + camera values they're holding; screen-share state
  // comes from the ref, which is authoritative at every call site.
  const sendMediaState = useCallback(
    // Tied to MediaState rather than spelled out, so renaming a field there is
    // a compile error here instead of a silently-ignored property.
    async (state: Omit<MediaState, 'isScreenSharing'>) => {
      const transport = transportRef.current;
      // No session or no peer → nobody to tell.
      if (!transport || !sessionIdRef.current || !peerNameRef.current) return;
      try {
        await transport.notifyMediaStateChange(sessionIdRef.current, {
          ...state,
          isScreenSharing: !!localScreenStreamIdRef.current,
        });
      } catch (err) {
        // Stale badges aren't worth interrupting the call over — the next
        // toggle or screen-share event resyncs them.
        logger.error('[Session] Failed to notify media state change:', err);
      }
    },
    [],
  );

  // Post-C4: auth is via cookie. We just gate connection on whether the user
  // is logged in at all — the cookie travels with the WebSocket handshake.
  const transport = useTransport(!!user, {
    onPeerJoined: async (displayName) => {
      setPeerHasLeft(false);
      setPeerName(displayName);
      peerNameRef.current = displayName;
      setToast({ message: `${displayName} joined the session`, type: 'info' });

      await offerToPeer();
      // Deliberately outside offerToPeer, which no-ops for the answering side:
      // the peer needs our badges whether or not we are the one who offers.
      await sendMediaState({ isMuted, isCameraOn });
      await declareScreenShareState();
    },
    onExistingPeer: (displayName, sharing) => {
      setPeerHasLeft(false);
      setPeerName(displayName);
      peerNameRef.current = displayName;

      // The room's record, not our memory of it. This is the whole reason the
      // server tracks it: our own copy could have missed the stop that ended
      // their last share, and nothing else in the session would ever correct
      // it — leaving us convinced someone is sharing and silently refusing
      // every request they make from then on.
      if (sharing) {
        setCurrentScreenSharer(displayName);
        webrtc.setRemoteScreenShareStreamId(sharing);
      } else if (!localScreenStreamIdRef.current) {
        // Guarded, because currentScreenSharer may be US. The room reporting
        // that the OTHER side is not sharing says nothing about our own share.
        setCurrentScreenSharer(null);
        webrtc.setRemoteScreenShareStreamId(null);
      }

      // We're the side that just walked in, so nobody has heard our state yet
      // — and the preflight lobby may already have put us in muted /
      // camera-off (see the initial?.micOff handling in joinExistingSession).
      // Without this the peer renders default badges for us until our first
      // in-call toggle.
      void sendMediaState({ isMuted, isCameraOn });
      void declareScreenShareState();
    },
    // The peer replaced their socket — refresh, tab restore, network flap. The
    // server tells us rather than leaving us to infer it from a PeerLeft that
    // never arrives, and a fresh offer rebuilds the peer connection their
    // reload destroyed. This is the half of reconnect SignalR never had:
    // withAutomaticReconnect restored the transport and nothing rejoined the
    // room or renegotiated the media.
    onPeerReconnected: async (displayName) => {
      setPeerHasLeft(false);
      setPeerName(displayName);
      peerNameRef.current = displayName;

      await offerToPeer();
      // Their reload wiped whatever we last told them, so this is a re-announce
      // rather than an update.
      await sendMediaState({ isMuted, isCameraOn });
      await declareScreenShareState();
    },
    onReconnecting: () => {
      setToast({ message: 'reconnecting…', type: 'warning' });
    },
    onReconnected: () => {
      setToast({ message: 'back online', type: 'info' });
      // Our own socket came back. The peer's view of us is as old as the drop,
      // and ExistingPeer only repairs the direction pointing the other way.
      void declareScreenShareState();
    },
    onFatal: (reason) => {
      setError(reason);
      setToast({ message: reason, type: 'error' });
      // Nothing is coming back over this socket, so an outstanding request will
      // never be answered. Release the capture rather than leave the browser
      // announcing a share into a dead session.
      cancelPendingScreenShare(null);
    },
    onPeerLeft: (displayName) => {
      setPeerHasLeft(true);
      setToast({ message: `${displayName || 'Peer'} has left the session`, type: 'warning' });
      setPeerName(null);
      peerNameRef.current = null;
      setPeerMediaState(null);
      // A verdict describes one peer's link. Carrying it into whoever joins
      // next would judge a stranger's connection by the last one's troubles.
      viewerReportRef.current = null;
      setPeerQualityFeedback(null);
      setCurrentScreenSharer(null);
      webrtc.setRemoteScreenShareStreamId(null);
      webrtc.clearRemoteStreams();
      setInviteUrl(null);
      setInviteExpiry(null);
      setPeerVolume(100);
      setHasScreenAudio(false);
      setScreenAudioVolume(100);
      // The only person who could have approved is gone. Waiting on them is
      // waiting forever, and the pending capture is still running.
      cancelPendingScreenShare('they left before answering your share request');
      setScreenShareRequest(null);
    },
    onReceiveOffer: async (sdpOffer) => {
      try {
        await webrtc.setRemoteDescription(sdpOffer);
        const answer = await webrtc.createAnswer();
        if (sessionIdRef.current) {
          await transportRef.current?.sendAnswer(sessionIdRef.current, answer);
        }
      } catch (err) {
        logger.error('[transport] Failed to handle offer:', err);
      }
    },
    onReceiveAnswer: async (sdpAnswer) => {
      try {
        await webrtc.setRemoteDescription(sdpAnswer);
      } catch (err) {
        logger.error('[transport] Failed to set answer:', err);
      }
    },
    onReceiveIceCandidate: async (candidate) => {
      try {
        await webrtc.addIceCandidate(candidate);
      } catch (err) {
        logger.error('[transport] Failed to add ICE candidate:', err);
      }
    },
    onReceiveChatMessage: (message) => {
      addMessage(message);
      // Bump unread counter when the sidebar (and so the chat) is hidden.
      // Own messages never reach this handler — server broadcasts via
      // OthersInGroup — so any message that arrives is from the peer.
      if (!isSidebarOpenRef.current) {
        setUnreadMessages((n) => n + 1);
      }
      // Receiving a message implies the peer just hit send → they're no
      // longer "typing." Clear the indicator immediately.
      setPeerTypingAt(0);
      setPeerTypingName(null);
    },
    onPeerTyping: (displayName) => {
      setPeerTypingName(displayName);
      setPeerTypingAt(Date.now());
    },
    onPeerVideoSync: (_displayName, action, payload) => {
      // Three top-level branches: load (peer started co-watch), close
      // (peer exited), and play/pause/seek (delegate to the player ref).
      if (action === 'load') {
        const id = extractYouTubeVideoId(payload);
        if (id) setWatchVideoId(id);
      } else if (action === 'close') {
        setWatchVideoId(null);
      } else if (action === 'play' || action === 'pause' || action === 'seek') {
        const seconds = parseFloat(payload) || 0;
        watchPlayerRef.current?.applyRemoteAction(action, seconds);
      }
    },
    onPeerCursor: (displayName, x, y) => {
      // Peer's cursor over the shared content. We store normalized 0..1
      // coordinates; ScreenShareView re-projects them onto its own
      // container rect. lastSeenAt drives the auto-fade — 1500ms of
      // silence and the halo dissolves.
      setPeerCursor({ x, y, name: displayName, lastSeenAt: Date.now() });
    },
    onPeerReaction: (displayName, emoji) => {
      // Push a new floating reaction. Keyed by Date.now() + random — guard
      // against two reactions in the same millisecond getting the same key.
      const id = Date.now() * 1000 + Math.floor(Math.random() * 1000);
      setReactions((prev) => [...prev, { id, emoji, from: displayName }]);
      // Auto-cull after the float animation finishes (2200ms float + slack).
      window.setTimeout(() => {
        setReactions((prev) => prev.filter((r) => r.id !== id));
      }, 2400);
    },
    onPeerMediaStateChanged: (_displayName, state) => {
      setPeerMediaState(state);
    },
    onScreenShareRequested: (displayName) => {
      const currentSessionId = sessionIdRef.current;
      if (!currentSessionId) return;

      // Never fall through without answering. This used to be a bare
      // `if (!currentScreenSharer)` with no else, and a dropped request sent
      // nothing back — so the asker sat on "waiting for approval" forever with
      // every retry path disabled, and the only way out was a new session.
      if (currentScreenSharer && currentScreenSharer !== displayName) {
        // Somebody really is sharing, and it is not the person asking — in a
        // two-person room, us. Say no out loud.
        void transportRef.current?.respondScreenShare(currentSessionId, false);
        return;
      }

      if (currentScreenSharer) {
        // The asker IS the peer we have on record as sharing. They would not be
        // asking if that were still true, so the record is what is stale — a
        // stop that never reached us, or a share we pinned at approval that
        // never started. Trust the request over our own bookkeeping.
        setCurrentScreenSharer(null);
        webrtc.setRemoteScreenShareStreamId(null);
      }

      setScreenShareRequest({ from: displayName, timestamp: Date.now() });
    },
    onScreenShareResponse: async (approved) => {
      setIsWaitingForApproval(false);

      if (!approved || !sessionIdRef.current || !pendingScreenShareRef.current) {
        // Says so out loud now. A silent stop was indistinguishable from the
        // request never having been delivered, which is the failure this whole
        // change is about.
        cancelPendingScreenShare(approved ? null : 'screen share request declined');
        return;
      }

      const { stream, streamId } = pendingScreenShareRef.current;

      // Wrapped, because a throw partway through used to leave
      // pendingScreenShareRef set and the capture running — and, worse, leave
      // the VIEWER pinned to a sharer whose share never started, so every later
      // request from us was refused by their own stale bookkeeping.
      try {
        localScreenStreamIdRef.current = streamId;
        // Via the ref, not the render-time value: this callback is registered
        // once and its closure is stale by the time an approval arrives.
        await webrtc.addScreenShareTracks(stream, operatingPointRef.current);
        setCurrentScreenSharer(user?.username ?? 'You');

        await transportRef.current?.notifyScreenShareStarted(sessionIdRef.current, streamId);

        const offer = await webrtc.createOffer();
        await transportRef.current?.sendRenegotiationOffer(sessionIdRef.current, offer);

        await transportRef.current?.notifyMediaStateChange(sessionIdRef.current, {
          isMuted,
          isCameraOn,
          isScreenSharing: true,
        });

        pendingScreenShareRef.current = null;
      } catch (err) {
        logger.error('[Session] Failed to start the approved screen share:', err);
        localScreenStreamIdRef.current = null;
        setCurrentScreenSharer(null);
        // Retract it, so the peer is not left believing in a share that never
        // reached the wire.
        await transportRef.current?.stopScreenShare(sessionIdRef.current);
        cancelPendingScreenShare('could not start the screen share');
      }
    },
    onScreenShareStarted: (displayName, streamId) => {
      setCurrentScreenSharer(displayName);
      webrtc.setRemoteScreenShareStreamId(streamId);
    },
    onScreenShareStopped: (displayName) => {
      if (currentScreenSharer === displayName) {
        setCurrentScreenSharer(null);
        webrtc.setRemoteScreenShareStreamId(null);
        setHasScreenAudio(false);
        setScreenAudioVolume(100);
      }
    },
    onReceiveRenegotiationOffer: async (sdpOffer) => {
      // Perfect negotiation: detect offer glare (both peers renegotiated at once).
      // An offer arriving while we're making our own (or aren't stable) is a
      // collision. The impolite peer (creator) ignores it and keeps its own; the
      // polite peer (joiner) accepts it — setRemoteDescription does an implicit
      // rollback of our pending local offer. Without this, crossing offers wedge
      // the signaling state and freeze the stream.
      try {
        const collision = webrtc.isMakingOffer() || webrtc.getSignalingState() !== 'stable';
        if (collision && !politeRef.current) {
          logger.warn('[Renegotiation] offer glare — impolite peer ignoring incoming offer');
          return;
        }
        await webrtc.setRemoteDescription(sdpOffer);
        const answer = await webrtc.createAnswer();
        if (sessionIdRef.current) {
          await transportRef.current?.sendRenegotiationAnswer(sessionIdRef.current, answer);
        }

        // The other half of perfect negotiation, which was missing.
        //
        // Accepting their offer during a collision rolled OUR pending offer
        // back, and an answer cannot carry m-lines the offer did not have — so
        // whatever we were renegotiating for, typically a screen share we had
        // just added, silently never reached the wire. The textbook design
        // leans on negotiationneeded firing again to re-offer; that handler is
        // not registered here, every renegotiation in this file being explicit,
        // so the re-offer has to be explicit too.
        if (collision && sessionIdRef.current) {
          logger.warn('[Renegotiation] re-offering after a polite rollback');
          const reoffer = await webrtc.createOffer();
          await transportRef.current?.sendRenegotiationOffer(sessionIdRef.current, reoffer);
        }
      } catch (err) {
        logger.error('[Renegotiation] failed to handle offer:', err);
      }
    },
    onReceiveRenegotiationAnswer: async (sdpAnswer) => {
      // Only apply an answer if we actually have a local offer outstanding. After
      // a polite rollback we're no longer waiting, so a late/stray answer must be
      // dropped rather than throwing the peer connection into a bad state.
      try {
        if (webrtc.getSignalingState() !== 'have-local-offer') {
          logger.warn('[Renegotiation] dropping unexpected answer (state:', webrtc.getSignalingState(), ')');
          return;
        }
        await webrtc.setRemoteDescription(sdpAnswer);
      } catch (err) {
        logger.error('[Renegotiation] failed to handle answer:', err);
      }
    },
    onReceiveShareStatus: (_displayName, status) => {
      // What the far end's encoder is doing. Two consumers: the frame rate is
      // the yardstick our own quality score is judged against, and the rest is
      // the diagnostics panel — the readout the person actually watching the
      // picture freeze could never see before.
      setPeerShareStatus(status);
    },
    onReceiveQualityFeedback: (_displayName, feedback) => {
      setPeerQualityFeedback(feedback);
      if (feedback.level === 'poor' || feedback.level === 'critical') {
        setToast({
          message: `Viewer experiencing ${feedback.level} connection quality`,
          type: 'warning',
        });
      }
      // Feedback and sender health feed one bandwidth controller. A second
      // preset ladder used to cut the quality again from the same bad sample.
      viewerReportRef.current = {
        level: feedback.level,
        // Absent from an older peer's build, which is why resolutionBox has a
        // conservative answer for null rather than requiring one.
        viewport: feedback.viewport ?? null,
        // The size that actually ARRIVED, against the size it is drawn at just
        // above. Absent for the same reason and answered the same way: see
        // viewerIsStarved, which is false whenever either term is missing.
        picture: feedback.picture ?? null,
        at: Date.now(),
      };
    },
  });

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  const handleQualityFeedback = useCallback(async (feedback: QualityFeedback) => {
    if (sessionIdRef.current && transportRef.current) {
      try {
        // Our size rides along with our verdict. Decorated here rather than
        // inside useQualityMonitor so that hook stays free of the DOM: it
        // measures the connection, not the layout.
        await transportRef.current.sendQualityFeedback(sessionIdRef.current, {
          ...feedback,
          ...(myViewportRef.current ? { viewport: myViewportRef.current } : {}),
        });
      } catch (err) {
        logger.error('[Quality] Failed to send feedback:', err);
      }
    }
  }, []);

  const isWatchingRemoteScreen = !!webrtc.remoteScreenStream && !webrtc.isScreenSharing;
  // Poll WebRTC stats any time the call is up — not only during screen-share
  // viewing. The header quality badge needs to reflect plain camera-call health
  // too. Feedback callback stays gated on isWatchingRemoteScreen so we don't
  // spam the peer with quality-feedback messages outside the screen-share path.
  const isCallActive = !!peerName && uiConnState === 'connected';
  const qualityMonitor = useQualityMonitor(
    isCallActive,
    isWatchingRemoteScreen ? handleQualityFeedback : undefined,
    // Only while watching a share: the sharer's frame rate says nothing about
    // a camera-only call, and the default is right for that.
    //
    // What it is SENDING in preference to what it is asking for. Those differ
    // by a factor of thirty whenever the shared window is still, and judging
    // arriving frames against frames that were never made is what turned a
    // paused video into a 'critical' report and a collapsing budget.
    isWatchingRemoteScreen
      ? (peerShareStatus?.sentFps ?? peerShareStatus?.fps)
      : undefined,
    isWatchingRemoteScreen ? webrtc.remoteScreenStream?.getVideoTracks()[0]?.id : undefined,
  );

  /*
   * Hold the last few minutes of all of it, so a bug report can describe what
   * happened rather than what is happening.
   *
   * Reads through a closure rebuilt every render, which the hook keeps in a ref
   * — the same arrangement useSenderHealth uses for its ceiling, and for the
   * same reason: the poller needs current state without the interval being torn
   * down every time any of that state moves.
   */
  const recorder = useDiagnosticsRecorder(isCallActive, () => {
    const metrics = qualityMonitor.metrics;
    const total = metrics ? metrics.packetsReceived + metrics.packetsLost : 0;
    const now = Date.now();
    return {
      path: diagnostics.path,
      uplink,
      point: webrtc.isScreenSharing ? operatingPoint : null,
      outbound: diagnostics.outbound,
      bpp: diagnostics.bpp,
      senderHealth: senderHealth.health,
      budgetBps: webrtc.isScreenSharing ? budget.bps : null,
      probing: budget.probing,
      capacityPixelsPerSecond,
      inbound: isWatchingRemoteScreen ? qualityMonitor.inbound : null,
      level: qualityMonitor.quality,
      score: qualityMonitor.score,
      lossPercent: metrics && total > 0 ? (metrics.packetsLost / total) * 100 : null,
      viewerLevel: currentViewerLevel(viewerReportRef.current, now),
      viewerViewport: currentViewerViewport(viewerReportRef.current, now),
      viewerPicture: currentViewerPicture(viewerReportRef.current, now),
      viewerStarved: viewerIsStarved(viewerReportRef.current, now),
      peerShare: isWatchingRemoteScreen ? peerShareStatus : null,
    };
  });

  /**
   * Assemble the report.
   *
   * Async only because the ICE tables come from getStats. Everything else is
   * already in memory — that is the whole point of the recorder.
   */
  const openDebugReport = useCallback(async () => {
    // A fresh sample first, so pressing this one second into a call still shows
    // the state that prompted it rather than an empty table.
    recorder.capture();

    const ice = await webrtcService
      .getIceDiagnostics()
      .then((d) => (d ? formatIceDiagnostics(d) : null))
      .catch(() => null);

    setDebugReport(
      formatDiagnosticsReport({
        header: {
          generatedAt: new Date().toISOString(),
          sessionId: sessionIdRef.current,
          role: webrtc.isScreenSharing ? 'sharer' : isWatchingRemoteScreen ? 'viewer' : 'idle',
          userAgent: navigator.userAgent,
          devicePixelRatio: window.devicePixelRatio || 1,
          quality: screenShareQuality,
          contentMode,
          codec: webrtcService.getScreenCodec(),
          viewport: myViewportRef.current,
        },
        samples: recorder.samples(),
        logs: logBuffer.snapshot(),
        ice,
      }),
    );
  }, [recorder, webrtc.isScreenSharing, isWatchingRemoteScreen, screenShareQuality, contentMode]);

  // Samples reset when sharing starts: eighteen seconds of camera-only readings
  // describe a completely different load than the one a share is about to place.
  const uplink = useUplinkEstimate(isCallActive, webrtc.isScreenSharing);
  const diagnostics = useTransportDiagnostics(isCallActive);

  /** What the link has earned, held across polls so it cannot decay. */
  const [budget, setBudget] = useState<BudgetState>(() =>
    initialBudgetState(coldStartBudgetBps(true), Date.now()),
  );
  const budgetBps = budget.bps;

  /*
   * What this machine's encoder has been shown to sustain, in pixels per second.
   *
   * The fourth bound on the picture, beside the budget, the preset and the
   * viewer's viewport — and the only one about the sender itself. It exists
   * because `cpu-bound` was a state nothing could answer: the budget holds on
   * it by design, the ladder holds on it by design, and the viewer's report
   * never reaches either. Something had to be able to come down.
   */
  const [capacity, setCapacity] = useState<CapacityState>(initialCapacityState);
  const capacityPixelsPerSecond = capacity.maxPixelsPerSecond;

  /** Last poll's encoder readout, so the cumulative counters can be differenced. */
  const previousSenderSampleRef = useRef<OutboundScreenStats | null>(null);

  /*
   * The peer's viewport, as of the last poll, or null when they have not
   * reported one recently.
   *
   * State rather than a ref because it changes the operating point, and the
   * memo below has to see it. Refreshed from viewerReportRef on the budget
   * effect's own three-second cadence, which is also how it gets to EXPIRE —
   * an old report going stale has to move this, and only a tick can notice
   * that nothing arrived.
   */
  const [viewerViewport, setViewerViewport] = useState<Viewport | null>(null);

  /**
   * The operating point actually applied to the encoder.
   *
   * Derived, never stored: budget (measured, or a conservative cold start) plus
   * content mode plus the user's ceiling, run through the convex-hull chooser.
   * Six fixed rungs could not sit on that curve — which is why a 2 Mbps link
   * used to run 720p and leave a third of its uplink unused.
   */
  const operatingPoint = useMemo(
    () =>
      chooseOperatingPoint(
        budgetBps,
        contentMode,
        screenShareQuality,
        viewerViewport,
        capacityPixelsPerSecond,
      ),
    [budgetBps, contentMode, screenShareQuality, viewerViewport, capacityPixelsPerSecond],
  );

  /*
   * True when the chooser is already at its floor — the link cannot fund a
   * bigger picture, so nothing the controller does will improve it. Derived
   * from the applied point rather than the budget so it stays correct however
   * the budget is represented.
   */
  const atBudgetFloor = operatingPoint.videoBps <= minVideoBps(operatingPoint.fps);

  // Sender health controls the budget and encode-capacity limits.
  // Judged against the ceiling we actually set, so "is it getting its ask" is a
  // real question rather than a restatement of what we chose to send.
  //
  // The geometry goes in beside the bitrate so `source-idle` can be told apart
  // from a shortage: a frame rate far under the ask, at a picture that is still
  // full size, is a capture with nothing to capture rather than a link with
  // nothing to spare.
  const [appliedPoint, setAppliedPoint] = useState<OperatingPoint | null>(null);
  const askedGeometry = useMemo(
    () =>
      webrtc.isScreenSharing && appliedPoint
        ? { area: appliedPoint.width * appliedPoint.height, fps: appliedPoint.fps }
        : null,
    [webrtc.isScreenSharing, appliedPoint],
  );
  const senderHealth = useSenderHealth(
    webrtc.isScreenSharing,
    appliedPoint?.videoBps ?? null,
    askedGeometry,
  );

  /*
   * The uplink estimate, reachable without depending on its identity.
   *
   * This ref is the fix for the collapse in the captured session, and the bug
   * was in the dependency array below rather than in any of the arithmetic.
   * `uplink` was a dependency, and useUplinkEstimate builds a fresh object
   * every three seconds on a timer of its own — so `nextBudget` ran on TWO
   * unsynchronised tickers, and its multiplicative decrease compounded about
   * twice per health observation: 0.85^2 = 0.72 per poll against a designed
   * 0.85. Eleven `updateScreenShareQuality` steps across six polls, 2 Mbps to
   * the floor in twenty-one seconds, while the encoder needed several seconds
   * to converge onto each new ceiling — so `under-served` stayed true all the
   * way down and the hysteresis useSenderHealth documents never got a chance to
   * engage.
   *
   * Read through a ref, the budget advances once per observation and uses the
   * freshest estimate available at that moment, which is what the comment on
   * this effect claimed all along.
   */
  const uplinkRef = useRef(uplink);
  useEffect(() => {
    uplinkRef.current = uplink;
    // Latched here rather than at the point of use; see capacityMeasurable.
    if (uplink) setCapacityMeasurable(uplink.capacityKnown);
  }, [uplink]);

  /*
   * Advance the budget on every sender-health observation, and only then.
   *
   * `senderHealth.tick` is the dependency that means "a new sample exists". It
   * replaces `senderHealth.streak`, which was wrong in both directions: streak
   * resets to 1 when the verdict changes, so an alternating verdict holds it at
   * 1 and the effect never re-runs at all, and it was joined by `uplink`, whose
   * independent timer ran this reducer a second time per poll. See
   * SenderHealthState.tick.
   *
   * `capacityKnown` gates the estimate: a TCP-relay reading is a measured lower
   * bound, not a capacity measurement, and nextBudget's contract is that null
   * means "no opinion" rather than "no bandwidth".
   */
  const lastBudgetTickRef = useRef(-1);
  useEffect(() => {
    if (!webrtc.isScreenSharing || lastBudgetTickRef.current === senderHealth.tick) return;
    lastBudgetTickRef.current = senderHealth.tick;
    const now = Date.now();
    const uplink = uplinkRef.current;
    // Same freshness rule as the verdict: a viewport nobody has confirmed in
    // thirty seconds must stop authorising a picture that large.
    const viewport = currentViewerViewport(viewerReportRef.current, now);
    setViewerViewport((prev) => (sameViewport(prev, viewport) ? prev : viewport));
    setBudget((prev) =>
      nextBudget(prev, {
        now,
        viewport,
        estimateBps: uplink?.capacityKnown ? uplink.uplinkBps : null,
        health: senderHealth.health,
        // Receiver feedback also works when the transport has no capacity estimate.
        // Expire old reports instead of pinning a past failure forever.
        viewerUnhappy: viewerIsUnhappy(currentViewerLevel(viewerReportRef.current, now)),
        viewerReportAt: viewerReportRef.current?.at ?? null,
        viewerHealthy: ['good', 'excellent'].includes(currentViewerLevel(viewerReportRef.current, now) ?? ''),
        // The other direction, and until now there was no other direction: the
        // receiver could ask for less and never for more, because its score has
        // no resolution term and a collapsed picture arriving cleanly reports
        // 'excellent'. This is the far end saying "I have room for more than
        // this", which earns a probe rather than a back-off.
        viewerStarved: viewerIsStarved(viewerReportRef.current, now),
        headroom: HEADROOM_SELECT,
        mode: contentMode,
        ceiling: screenShareQuality,
        // The cap has to see every bound the chooser sees, or the budget spends
        // its probe cycles climbing toward a picture the encoder will not run.
        capacityPixelsPerSecond,
      }),
    );
    // `health` rides along for the linter's benefit and costs nothing: it is
    // set in the same update as `tick`, so the two can never change on separate
    // renders. `tick` is the one that means "a new sample exists".
  }, [senderHealth.tick, senderHealth.health, contentMode, screenShareQuality, capacityPixelsPerSecond, webrtc.isScreenSharing]);

  // A new share is a new load; carrying the old budget across would judge it by
  // the previous one's behaviour. The viewer's verdict goes with it, for the
  // same reason and more sharply: feedback is only sent while a share is being
  // watched, so a report that outlives one is by definition about the last one.
  useEffect(() => {
    if (!webrtc.isScreenSharing) {
      // Sized to the path we are actually on. On a TCP/TLS relay nothing will
      // ever be able to tell us a generous opening bid was too generous, so the
      // opening bid is where that has to be got right — see coldStartBudgetBps.
      //
      // `capacityMeasurable` is a dependency so this re-seeds the instant the
      // path reveals itself, while still idle. The share that starts a moment
      // later then reads an operating point that already fits.
      lastBudgetTickRef.current = -1;
      setBudget(initialBudgetState(coldStartBudgetBps(capacityMeasurable), Date.now()));
      viewerReportRef.current = null;
      // A new share is a new encode. Carrying a ceiling learned from the last
      // one would judge a 720p window by what a 4K one cost.
      setCapacity(initialCapacityState());
      previousSenderSampleRef.current = null;
    }
  }, [webrtc.isScreenSharing, capacityMeasurable]);

  // Long-lived signalling callbacks (screen-share approval, in particular) are
  // registered once and close over their first render, so anything they need
  // from the current point has to come through a ref.
  const operatingPointRef = useRef(operatingPoint);
  useEffect(() => {
    operatingPointRef.current = operatingPoint;
  }, [operatingPoint]);

  // Apply the point whenever it genuinely changes. sameOperatingPoint guards
  // against re-applying identical parameters every time the estimate wobbles by
  // a few kbps — setParameters is cheap but not free, and churn here shows up
  // as encoder resets.
  const appliedPointRef = useRef<OperatingPoint | null>(null);
  useEffect(() => {
    if (!webrtc.isScreenSharing) {
      appliedPointRef.current = null;
      setAppliedPoint(null);
      return;
    }
    if (sameOperatingPoint(appliedPointRef.current, operatingPoint)) return;
    let active = true;
    void webrtc.updateScreenShareQuality(operatingPoint).then(() => {
      if (!active) return;
      const acknowledged = webrtcService.getAppliedScreenPoint();
      appliedPointRef.current = acknowledged;
      setAppliedPoint((previous) => sameOperatingPoint(previous, acknowledged) ? previous : acknowledged);
    }).catch((err) => logger.debug('[Quality] Could not apply operating point:', err));
    return () => { active = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatingPoint, webrtc.isScreenSharing, senderHealth.tick]);

  /*
   * Advance the encode ceiling on every sender-health observation.
   *
   * Its own effect, not folded into the budget one, because it answers a
   * different question with a different signal: the budget asks what the LINK
   * can carry and reads the bandwidth estimate, this asks what the MACHINE can
   * encode and reads the encoder's own clock. One hook, one concern.
   *
   * Measured against `appliedPointRef` rather than `operatingPoint`: the sample
   * we are about to judge was produced by whatever the encoder was actually
   * running, which on the tick after a change is not yet the point we just
   * derived.
   */
  useEffect(() => {
    if (!webrtc.isScreenSharing) return;
    const applied = appliedPointRef.current;
    if (!applied) return;

    const previous = previousSenderSampleRef.current;
    previousSenderSampleRef.current = senderHealth.latest;

    setCapacity((prev) =>
      nextCapacity(prev, {
        now: Date.now(),
        health: senderHealth.health,
        previous,
        latest: senderHealth.latest,
        askedPixelsPerSecond: applied.width * applied.height * applied.fps,
        fps: applied.fps,
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderHealth.health, senderHealth.tick, webrtc.isScreenSharing]);

  /*
   * Tell the viewer what our encoder is doing.
   *
   * The counterpart to the quality feedback coming the other way, and it exists
   * because the two ends knew completely different things. The sharer could see
   * the operating point, the encoder's real output and what was limiting it;
   * the viewer — the one actually watching the picture stop and start — could
   * see a coloured bar. A bug report could only ever say "it looks choppy",
   * which is exactly how far the last one got.
   *
   * On the diagnostics cadence rather than only on change, so `limitedBy` and
   * the encoder name stay fresh. It rides the DataChannel, which is what that
   * channel is for: no Durable Object request, no server, no cost.
   */
  useEffect(() => {
    if (!webrtc.isScreenSharing) return;
    const transport = transportRef.current;
    const sessionId = sessionIdRef.current;
    if (!transport || !sessionId) return;

    void transport
      .sendShareStatus(sessionId, {
        fps: operatingPoint.fps,
        width: operatingPoint.width,
        height: operatingPoint.height,
        bps: operatingPoint.videoBps,
        // What is actually leaving, beside what was asked for. This is the
        // receiver's yardstick — see ShareStatus.sentFps — so it is measured,
        // never inferred: a browser that does not publish it sends nothing and
        // the far end keeps using the ask.
        ...(typeof diagnostics.outbound?.framesPerSecond === 'number'
          ? { sentFps: diagnostics.outbound.framesPerSecond }
          : {}),
        ...(diagnostics.outbound?.qualityLimitationReason
          ? { limitedBy: diagnostics.outbound.qualityLimitationReason }
          : {}),
        ...(diagnostics.outbound?.encoderImplementation
          ? { encoder: diagnostics.outbound.encoderImplementation }
          : {}),
      })
      .catch(() => {
        /* best-effort presence traffic, exactly like the cursor */
      });
  }, [operatingPoint, diagnostics.outbound, webrtc.isScreenSharing]);

  /*
   * The peer's readout belongs to the share it described. With no remote share
   * to watch, a stale one would render as fact.
   */
  useEffect(() => {
    if (!isWatchingRemoteScreen) setPeerShareStatus(null);
  }, [isWatchingRemoteScreen]);

  /*
   * CPU pressure needs a different answer than bandwidth pressure, and now it
   * gets one.
   *
   * Two answers, in fact, and they are complementary. `encodeCapacity` has
   * already begun taking pixels away — that runs on every poll and needs
   * nothing from here. This effect handles the case pixels cannot fix: an
   * encoder with no hardware path for the codec we chose, where a smaller
   * picture only postpones the cliff. VP9 has no hardware encoder on Apple
   * Silicon at all, and `preferVp9` asked for it unconditionally.
   *
   * Guarded on `stable` because this drives a renegotiation and the sharer may
   * be the polite peer, whose offer is rolled back on a collision. That is
   * self-correcting rather than tracked: the codec preference is sticky on the
   * transceiver, so a lost race still leaves it set, and the next poll retries
   * the offer. `downgradeScreenCodec` is one-way, so the retry cannot oscillate.
   */
  useEffect(() => {
    if (!webrtc.isScreenSharing) return;
    if (!shouldDowngradeCodec(senderHealth.latest, senderHealth.health)) {
      if (senderHealth.health === 'cpu-bound') {
        // Hardware encoder, or a browser that says nothing about it. The pixel
        // bound is doing what it can; the rest is the machine.
        setToast({
          message: 'Encoder is CPU-limited — reducing picture size',
          type: 'warning',
        });
      }
      return;
    }

    const transport = transportRef.current;
    const sessionId = sessionIdRef.current;
    if (!transport || !sessionId) return;
    if (webrtc.getSignalingState() !== 'stable') return;

    if (!webrtc.downgradeScreenCodec()) return;
    // Capacity learned from the old software codec says nothing about the new encoder.
    setCapacity(initialCapacityState());
    previousSenderSampleRef.current = null;

    setToast({
      message: 'Switching to a codec this machine can encode — one moment',
      type: 'info',
    });

    void (async () => {
      try {
        const offer = await webrtc.createOffer();
        await transport.sendRenegotiationOffer(sessionId, offer);
      } catch (err) {
        // The preference is already on the transceiver; any later renegotiation
        // from either side carries it. Nothing to undo.
        logger.error('[Quality] codec downgrade renegotiation failed:', err);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [senderHealth.health, senderHealth.tick, webrtc.isScreenSharing]);

  /*
   * A link genuinely below the floor. Say so.
   *
   * The floor guarantees we never ask the encoder for an unrunnable picture,
   * but it cannot conjure bandwidth: if the encoder is still under-served at
   * 640x360, the link really cannot carry a screen share. That is worth one
   * honest sentence — the behaviour it replaces was to silently send a
   * slideshow and let the user wonder what was broken.
   */
  useEffect(() => {
    if (!webrtc.isScreenSharing) return;
    if (senderHealth.health !== 'under-served' || !atBudgetFloor) return;
    setToast({
      message: 'This connection is too slow for a screen share right now',
      type: 'warning',
    });
  }, [senderHealth.health, atBudgetFloor, webrtc.isScreenSharing]);

  useEffect(() => {
    sessionIdRef.current = sessionId;
  }, [sessionId]);

  // Push our media state to the peer whenever the mic or camera toggles.
  // The toggle handlers (MediaControls, ScreenShareView, keyboard shortcuts)
  // only flip local state + the sender's enabled flag — nothing on the wire.
  // Without this the peer's mute / camera-off badges stay frozen at whatever
  // the last peer-joined or screen-share event happened to push. A few
  // messages per session, so the extra signalling traffic is noise.
  const hasSyncedInitialMediaStateRef = useRef(false);
  useEffect(() => {
    // Skip the first run: there's no peer at mount, and the peer-appeared
    // handlers already send whatever state is current at that moment.
    if (!hasSyncedInitialMediaStateRef.current) {
      hasSyncedInitialMediaStateRef.current = true;
      return;
    }
    // sendMediaState no-ops when there's no peer yet — whoever joins next
    // picks up the current state from onPeerJoined / onExistingPeer.
    void sendMediaState({ isMuted, isCameraOn });
  }, [isMuted, isCameraOn, sendMediaState]);

  const joinExistingSession = useCallback(async (
    targetSessionId: string,
    preflightStream?: MediaStream,
    initial?: PreflightInitialState,
  ) => {
    if (!user || isJoining) return;
    setIsJoining(true);
    setStage('joining');
    setError(null);

    try {
      const validation = await api.validateSession(targetSessionId);
      if (!validation.valid) {
        throw new Error('Session is full or does not exist');
      }

      sessionIdRef.current = targetSessionId;

      await webrtc.initialize();

      if (preflightStream) {
        // Stream already acquired in PreflightLobby — just wire its tracks
        // into the freshly-built peer connection.
        webrtc.attachLocalStream(preflightStream);

        // If the user pre-toggled mic/camera off in the lobby, route through
        // the SAME toggle pipeline the in-call buttons use. This is important
        // for the camera case in particular: the lobby only flipped
        // track.enabled=false (LED stays lit for snappy preview toggling), but
        // the in-call pipeline (Stretch 16) physically stops the track and
        // replaceTrack(null)s the sender — so the camera LED honestly goes
        // dark the moment the user lands in the room. We do this BEFORE
        // transport.joinSession so the first offer reflects the chosen state.
        if (initial?.micOff) {
          toggleMute(webrtc.toggleAudio);
        }
        if (initial?.camOff) {
          // toggleVideo is async (stop + replaceTrack), but we don't await —
          // the offer doesn't need to wait, and toggleCamera fires the state
          // flip synchronously. The replaceTrack(null) lands well before the
          // first frame would have been encoded anyway.
          toggleCamera(webrtc.toggleVideo);
        }
      } else {
        // Fallback for code paths that bypass preflight (retry-on-error,
        // future deep links). Same behavior as before: best-effort, swallow
        // a denial and let the user enter as listen-only.
        try {
          await webrtc.getUserMedia(true, true);
        } catch (mediaErr) {
          logger.warn('[Session] Media access failed, continuing without:', mediaErr);
        }
      }

      // Resolves on the server's Joined frame — the readiness barrier that
      // JoinSession's boolean return used to be. A room that is full or gone
      // rejects with a message worth showing rather than a bare false.
      const joined = await transport.joinSession(targetSessionId);

      // Assigned with no await in between, deliberately: the promise settles
      // inside the socket's message handler, so this runs as a microtask before
      // any further frame can be delivered. An await here would open a gap in
      // which a PeerJoined could arrive and find isInitiatorRef still false —
      // and then nobody would ever offer.
      isInitiatorRef.current = joined.isOfferer;
      politeRef.current = !joined.isOfferer;

      setSessionId(targetSessionId);
      setStage('live');

      // We arrived second. Nobody will announce the peer to us — they were
      // already here — so if we are the offerer, this is our cue.
      if (joined.existingPeers.length > 0) {
        await offerToPeer();
        // Read from what the lobby said rather than from isMuted/isCameraOn:
        // the toggles above were applied moments ago and this closure still
        // sees the pre-toggle render. onExistingPeer also sends, but whether
        // its handler is the fresh one is a race — this is the authoritative
        // send, and the [isMuted, isCameraOn] effect below is the backstop.
        await sendMediaState({
          isMuted: initial?.micOff ?? false,
          isCameraOn: !(initial?.camOff ?? false),
        });
      }
    } catch (err) {
      logger.error('[Session] Failed to join session:', err);
      const errorMessage = err instanceof Error ? err.message : 'Failed to join session';
      setError(errorMessage);
      sessionIdRef.current = null;
      webrtc.close();
      // On error we drop back to preflight so the user has somewhere to be
      // (and the error banner renders alongside it from the error state).
      setStage('preflight');
    } finally {
      setIsJoining(false);
    }
  }, [user, isJoining, webrtc, transport, offerToPeer, sendMediaState, setSessionId, toggleMute, toggleCamera]);

  const handlePreflightReady = useCallback((stream: MediaStream, initial: PreflightInitialState) => {
    if (!urlSessionId) {
      // Defensive — every concrete entry point sets a sessionId in the URL.
      // If we ever get here without one, bounce back to lobby.
      navigate('/');
      return;
    }
    joinExistingSession(urlSessionId, stream, initial);
  }, [urlSessionId, joinExistingSession, navigate]);

  const handlePreflightCancel = useCallback(() => {
    navigate('/');
  }, [navigate]);

  const handleLeave = async () => {
    if (sessionIdRef.current) {
      await transport.leaveSession(sessionIdRef.current);
    }
    webrtc.close();
    setSessionId(null);
    setPeerName(null);
    peerNameRef.current = null;
    setPeerMediaState(null);
    setPeerHasLeft(false);
    setCurrentScreenSharer(null);
    clearMessages();
    isInitiatorRef.current = false;
    sessionIdRef.current = null;
    navigate('/');
  };

  const handleQualityChange = async (quality: ScreenShareQuality) => {
    // An explicit pick is a CEILING and a fresh statement of intent: it moves
    // quality now, bounds every later automatic step, and resets the probe
    // backoff. It is also the ONLY thing in this component that writes storage.
    setScreenShareQuality(quality);
    localStorage.setItem('wt:screenShareQuality', quality);

    // No direct call to updateScreenShareQuality here. Changing the ceiling
    // changes the derived operating point, and the effect that watches it does
    // the applying — one code path to the encoder rather than two racing ones.
    // That path is always non-disruptive: it adjusts the existing sender (no
    // track swap, no renegotiation, no getDisplayMedia re-prompt), so a quality
    // tweak can never freeze the viewer or re-ask for screen permission.
    if (!webrtc.isScreenSharing) {
      setToast({ message: 'Quality saved — applies to your next share', type: 'info' });
      return;
    }
    setToast({
      message: `quality → ${QUALITY_PRESETS[quality].label.toLowerCase()}`,
      type: 'info',
    });
  };

  /**
   * Content mode is a user preference, so it persists — unlike anything the
   * controller does on its own. The live share picks the new frame rate up through
   * the operating-point effect; no renegotiation, no re-prompt.
   */
  const handleContentModeChange = (mode: ContentMode) => {
    setContentMode(mode);
    localStorage.setItem('wt:contentMode', mode);
  };

  const handleRequestScreenShare = async () => {
    try {
      const { stream, streamId, hasAudio } = await webrtc.captureScreen(operatingPoint);

      // Warn the sharer when no audio was captured. Most common cause: Safari +
      // "Window" or "Entire Screen" share (Safari only captures audio for *Tab*
      // shares, and only with the "Share audio" checkbox ticked). Without this
      // warning the user has no idea their friend can't hear the shared content.
      if (!hasAudio) {
        setToast({
          message: "No audio captured — try sharing a Tab and check 'Share audio'.",
          type: 'warning',
        });
      }

      if (!sessionIdRef.current || !peerNameRef.current) {
        localScreenStreamIdRef.current = streamId;
        await webrtc.addScreenShareTracks(stream, operatingPoint);
        setCurrentScreenSharer(user?.username ?? 'You');

        if (sessionIdRef.current) {
          await transport.notifyScreenShareStarted(sessionIdRef.current, streamId);
          const offer = await webrtc.createOffer();
          await transport.sendRenegotiationOffer(sessionIdRef.current, offer);
          await transport.notifyMediaStateChange(sessionIdRef.current, {
            isMuted,
            isCameraOn,
            isScreenSharing: true,
          });
        }
        return;
      }

      pendingScreenShareRef.current = { stream, streamId };
      setIsWaitingForApproval(true);
      await transport.requestScreenShare(sessionIdRef.current);
    } catch (err) {
      logger.error('[Session] Screen share error:', err);
      // No message: the usual cause is the user dismissing the browser's own
      // picker, and there is nothing to tell them about a thing they just did.
      cancelPendingScreenShare(null);
    }
  };

  /**
   * Give up on a request the peer never answered.
   *
   * The peer is supposed to answer every request now — including a refusal when
   * they are the one sharing — so reaching this timeout means the frame itself
   * was lost, or their tab died between the ask and the answer. Either way the
   * user gets their button back instead of the session.
   */
  useEffect(() => {
    if (!isWaitingForApproval) return;

    const timer = window.setTimeout(() => {
      cancelPendingScreenShare('no answer to your share request — try again');
    }, SCREEN_SHARE_REQUEST_TIMEOUT_MS);

    return () => window.clearTimeout(timer);
  }, [isWaitingForApproval, cancelPendingScreenShare, SCREEN_SHARE_REQUEST_TIMEOUT_MS]);

  /** The waiting chip is a cancel button; this is what it does. */
  const handleCancelScreenShareRequest = () => {
    cancelPendingScreenShare(null);
  };

  const handleApproveScreenShare = async () => {
    if (!sessionIdRef.current || !screenShareRequest) return;
    await transport.respondScreenShare(sessionIdRef.current, true);
    setCurrentScreenSharer(screenShareRequest.from);
    setScreenShareRequest(null);
  };

  const handleDenyScreenShare = async () => {
    if (!sessionIdRef.current) return;
    await transport.respondScreenShare(sessionIdRef.current, false);
    setScreenShareRequest(null);
  };

  const handleStopScreenShare = async () => {
    try {
      const needsRenegotiation = await webrtc.stopScreenShare();
      setCurrentScreenSharer(null);
      localScreenStreamIdRef.current = null;

      if (sessionIdRef.current) {
        await transport.stopScreenShare(sessionIdRef.current);

        if (needsRenegotiation) {
          const offer = await webrtc.createOffer();
          await transport.sendRenegotiationOffer(sessionIdRef.current, offer);
        }

        await transport.notifyMediaStateChange(sessionIdRef.current, {
          isMuted,
          isCameraOn,
          isScreenSharing: false,
        });
      }
    } catch (err) {
      logger.error('[Session] Error stopping screen share:', err);
      setCurrentScreenSharer(null);
    }
  };

  // Published for handleScreenShareEnded, which is created before this exists.
  // No dependency array, matching webrtcRef above: handleStopScreenShare is a
  // fresh closure every render, and the point of the ref is to always hold the
  // current one. Safe in an effect because nothing reads it during render.
  useEffect(() => {
    handleStopScreenShareRef.current = handleStopScreenShare;
  });

  const handleSendMessage = async (message: string) => {
    if (sessionIdRef.current) {
      await transport.sendChatMessage(sessionIdRef.current, message);
    }
  };

  // Keyboard shortcuts only fire once we're in the live stage AND no modal
  // owns input (cheat sheet itself, ScreenShareRequest, etc.). The hook's
  // editable-target guard already skips chat input; this disable flag is
  // for cases where a modal sits above the page.
  useKeyboardShortcuts({
    enabled: stage === 'live' && !showCheatSheet && !screenShareRequest && debugReport === null,
    onMuteToggle: () => toggleMute(webrtc.toggleAudio),
    onCameraToggle: () => toggleCamera(webrtc.toggleVideo),
    onScreenShareToggle: () => {
      if (webrtc.isScreenSharing) {
        handleStopScreenShare();
      } else if (!currentScreenSharer && !isWaitingForApproval) {
        handleRequestScreenShare();
      }
      // else: someone else is sharing — silently no-op rather than confuse.
    },
    onSidebarToggle: () => setIsSidebarOpen((o) => !o),
    onCheatSheet: () => setShowCheatSheet(true),
    onDebugReport: () => void openDebugReport(),
  });

  useEffect(() => {
    if (!urlSessionId) {
      navigate('/', { replace: true });
    }
  }, [urlSessionId, navigate]);

  const hasTriedJoiningRef = useRef(false);
  // Auto-join on mount removed — joining now happens only via PreflightLobby's
  // onReady callback. hasTriedJoiningRef survives so the error-state TRY AGAIN
  // button (below) can re-arm a retry.

  // On a narrow screen the panel floats over the stage, so Escape should be
  // able to put it away like any other drawer.
  useEffect(() => {
    if (!isSidebarOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || window.matchMedia('(min-width: 1024px)').matches) return;
      if (document.querySelector('[role="dialog"]')) return;
      setIsSidebarOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isSidebarOpen]);

  if (!user) {
    return null;
  }

  // Stage 1: PreflightLobby — show until the user grants device permission
  // and commits to joining. We pass the stream straight into joinExistingSession,
  // bypassing the second getUserMedia call.
  if (stage === 'preflight' && !error) {
    return (
      <PreflightLobby
        onReady={handlePreflightReady}
        onCancel={handlePreflightCancel}
        contextHint={
          isCreator
            ? 'Starting a new session'
            : urlSessionId
              ? `Joining session ${urlSessionId.slice(0, 6)}…`
              : undefined
        }
      />
    );
  }

  if (isJoining || (!sessionId && !error)) {
    return (
      <div className="room-wait">
        <FilmLeader label={urlSessionId ? 'Joining the session…' : 'Creating the session…'} />
      </div>
    );
  }

  if (error) {
    return (
      <div className="room-wait">
        <m.div
          className="sheet room-wait__card"
          role="alert"
          initial={{ opacity: 0, y: 18, filter: 'blur(6px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.55, ease: ease.out }}
        >
          <span className="status-card__icon" aria-hidden="true">
            <AlertIcon size={28} />
          </span>
          <h1>Couldn’t join the session</h1>
          <p>{error}</p>
          <div className="cluster" style={{ justifyContent: 'center' }}>
            <Button variant="ghost" onClick={() => navigate('/')}>
              Back to lobby
            </Button>
            {urlSessionId && (
              <Button
                variant="primary"
                icon={<RefreshIcon size={18} />}
                onClick={() => {
                  // Back to the preflight stage. The user can re-pick devices
                  // (USB plug changes are a real recovery path) and commit again
                  // from there.
                  setError(null);
                  hasTriedJoiningRef.current = false;
                  setStage('preflight');
                }}
              >
                Try again
              </Button>
            )}
          </div>
        </m.div>
      </div>
    );
  }

  const isLocalSharing = webrtc.isScreenSharing;
  const canRequestShare = !currentScreenSharer && !isWaitingForApproval;
  const timeRemaining = getInviteTimeRemaining();

  // With nobody sharing and their camera up, the stage already IS their face,
  // so the side panel folds its copy of the faces away and gives chat the room.
  const stageShowsPeer =
    !watchVideoId &&
    !webrtc.localScreenStream &&
    !webrtc.remoteScreenStream &&
    !currentScreenSharer &&
    !peerHasLeft &&
    !!peerName &&
    !!webrtc.remoteCameraStream;

  // Friendly projection of uiConnState for the top bar. Kept in one place so
  // the overlay below keys off the same states.
  const connDisplay = (() => {
    switch (uiConnState) {
      case 'connected':    return { label: 'Connected' };
      case 'connecting':   return { label: 'Connecting…' };
      case 'reconnecting': return { label: 'Reconnecting…' };
      case 'lost':         return { label: 'Connection lost' };
      case 'idle':
      default:             return { label: peerName ? 'Setting up' : 'Ready' };
    }
  })();

  /*
   * The quality and voice controls, built once and spread into BOTH control
   * bars — the windowed one below, and the one ScreenShareView renders inside
   * its fullscreen container. They used to be listed on the windowed bar only,
   * which is why the fullscreen quality button was dead and its VOICE menu
   * empty. See MediaControlsQualityProps.
   */
  const qualityControls: MediaControlsQualityProps = {
    screenShareQuality,
    onQualityChange: handleQualityChange,
    uplink,
    diagnostics,
    appliedPoint: webrtc.isScreenSharing ? operatingPoint : null,
    atBudgetFloor,
    inbound: isWatchingRemoteScreen ? qualityMonitor.inbound : null,
    peerShare: isWatchingRemoteScreen ? peerShareStatus : null,
    contentMode,
    onContentModeChange: handleContentModeChange,
    peerVolume,
    onPeerVolumeChange: setPeerVolume,
  };

  // What lives behind the dock's "more" button. Watch together needs a live
  // call and a free stage (one main-panel mode at a time); blur needs a camera.
  const menuItems: DockMenuItem[] = [
    ...(isCallActive && !currentScreenSharer && !watchVideoId
      ? [
          {
            id: 'watch',
            label: 'Watch a video together',
            hint: 'Paste a YouTube link, playback stays in sync',
            icon: <PlayIcon size={18} />,
            onSelect: () => setShowWatchPrompt(true),
          },
        ]
      : []),
    ...(cameraTrack
      ? [
          {
            id: 'blur',
            label: blur.isLoading ? 'Preparing background blur…' : 'Background blur',
            hint: 'Blurs everything behind you',
            icon: <BlurIcon size={18} />,
            pressed: bgBlurEnabled,
            disabled: blur.isLoading,
            onSelect: () => setBgBlurEnabled((b) => !b),
          },
        ]
      : []),
    {
      id: 'shortcuts',
      label: 'Keyboard shortcuts',
      icon: <KeyboardIcon size={18} />,
      onSelect: () => setShowCheatSheet(true),
    },
  ];

  return (
    <div
      className="room"
      data-side={isSidebarOpen ? 'open' : 'closed'}
      data-resizing={isResizingSidebar ? '' : undefined}
      style={{ ['--side-w' as string]: `${sidebarWidth}px` }}
    >
      {/*
        Everything `position: fixed` at room level goes through FullscreenPortal.
        ScreenShareView's container is what goes fullscreen, and the browser
        paints nothing outside a fullscreen element — so without the portal an
        incoming share request, a "reconnecting…" toast, or the `D` debug modal
        (which also switches every keyboard shortcut off while it is open) all
        kept happening where nobody could see them. Outside fullscreen the
        portal renders inline and this tree is exactly what it was.
      */}
      <FullscreenPortal>
        {screenShareRequest && (
          <ScreenShareRequest
            requesterName={screenShareRequest.from}
            onApprove={handleApproveScreenShare}
            onDeny={handleDenyScreenShare}
          />
        )}

        <AnimatePresence>
          {toast && (
            <Toast key={toast.message} message={toast.message} type={toast.type} onClose={() => setToast(null)} />
          )}
        </AnimatePresence>

        <KeyboardShortcutsModal isOpen={showCheatSheet} onClose={() => setShowCheatSheet(false)} />

        <DebugReportModal
          isOpen={debugReport !== null}
          onClose={() => setDebugReport(null)}
          report={debugReport ?? ''}
        />

        <WatchUrlPrompt
          isOpen={showWatchPrompt}
          onSubmit={handleStartWatch}
          onCancel={() => setShowWatchPrompt(false)}
        />

        <FloatingReactions reactions={reactions} myName={user.username} />
      </FullscreenPortal>

      <header className="room-top">
        <div className="room-top__who">
          <Lights together={!!peerName && !peerHasLeft} size={40} />
          <div className="room-top__text">
            <span className="room-top__title" aria-live="polite">
              {peerName ? (
                <>
                  With <strong>{peerName}</strong>
                </>
              ) : peerHasLeft ? (
                'They left the session'
              ) : (
                'Waiting for someone to join'
              )}
            </span>
            <span className="room-top__meta">
              <span className="room-top__state" data-state={uiConnState}>
                <span className="chip__dot" data-live={uiConnState === 'connected' ? '' : undefined} aria-hidden="true" />
                {connDisplay.label}
              </span>
              {/* Only with a live call to measure. While connecting or
                  reconnecting the state above already tells the story. */}
              {isCallActive && (
                <ConnectionQualityBadge quality={qualityMonitor.quality} metrics={qualityMonitor.metrics} />
              )}
            </span>
          </div>
        </div>
        <div className="room-top__right">
          <span className="chip room-top__me" title="Signed in as">
            {user.tag}
          </span>
        </div>
      </header>

      <div className="room-body">
        <main className="room-main">
          <div className="stage-wrap" ref={stageWrapRef}>
            <div className="stage-glow" aria-hidden="true" />
            {/*
              A sibling of ScreenShareView, not a child, so in fullscreen it was
              painted underneath the share: an ICE drop looked like a picture
              that had silently frozen, with the TRY AGAIN button unreachable.
              Portaled into the fullscreen element it fills that element
              instead — `inset: 0` against a `position: fixed` container.
            */}
            {(uiConnState === 'reconnecting' || uiConnState === 'lost') && (
              <FullscreenPortal>
                <ConnectionOverlay
                  state={uiConnState}
                  onIceRestart={
                    uiConnState === 'lost'
                      ? () => {
                          // Manual nudge — fires the same ICE-restart path that
                          // the 5 s auto-restart inside webrtcService would take.
                          // Useful when the user notices a stale 'lost' state.
                          webrtc.createIceRestartOffer().then((offer) => {
                            if (sessionIdRef.current) {
                              transport.sendRenegotiationOffer(sessionIdRef.current, offer);
                            }
                          });
                        }
                      : undefined
                  }
                />
              </FullscreenPortal>
            )}
            {watchVideoId ? (
              <WatchTogetherPlayer
                ref={watchPlayerRef}
                videoId={watchVideoId}
                peerDisplayName={peerName}
                onLocalAction={handleLocalVideoAction}
                onClose={handleCloseWatch}
              />
            ) : (
              <ScreenShareView
                screenStream={isLocalSharing ? webrtc.localScreenStream : webrtc.remoteScreenStream}
                isLocalSharing={isLocalSharing}
                sharerName={currentScreenSharer}
                onRequestShare={handleRequestScreenShare}
                canRequestShare={canRequestShare}
                isWaitingForApproval={isWaitingForApproval}
                onCancelRequest={handleCancelScreenShareRequest}
                isMuted={isMuted}
                isCameraOn={isCameraOn}
                isScreenSharing={webrtc.isScreenSharing}
                onToggleMute={() => toggleMute(webrtc.toggleAudio)}
                onToggleCamera={() => toggleCamera(webrtc.toggleVideo)}
                onToggleScreenShare={
                  webrtc.isScreenSharing ? handleStopScreenShare : handleRequestScreenShare
                }
                onLeave={handleLeave}
                canShare={canRequestShare || webrtc.isScreenSharing}
                remoteCameraStream={webrtc.remoteCameraStream}
                localStream={webrtc.localStream}
                peerDisplayName={peerName}
                peerHasLeft={peerHasLeft}
                peerIsMuted={!!peerMediaState?.isMuted}
                peerIsCameraOff={peerMediaState ? !peerMediaState.isCameraOn : false}
                qualityLevel={qualityMonitor.quality}
                peerQualityLevel={peerQualityFeedback?.level}
                onHasScreenAudioChange={setHasScreenAudio}
                externalScreenAudioVolume={screenAudioVolume}
                peerCursor={peerCursor}
                onLocalCursor={handleLocalCursor}
                onViewportChange={handleViewportChange}
                onDebugReport={() => void openDebugReport()}
                waitingSlot={
                  <InviteCard
                    inviteUrl={inviteUrl}
                    isGenerating={isGeneratingInvite}
                    copied={inviteCopied}
                    timeRemaining={timeRemaining}
                    onGenerate={handleGenerateInvite}
                    onCopy={handleCopyInvite}
                  />
                }
                {...qualityControls}
              />
            )}
          </div>

          <div className="room-dock-wrap">
            <MediaControls
              isMuted={isMuted}
              isCameraOn={isCameraOn}
              isScreenSharing={webrtc.isScreenSharing}
              onToggleMute={() => toggleMute(webrtc.toggleAudio)}
              onToggleCamera={() => toggleCamera(webrtc.toggleVideo)}
              onToggleScreenShare={
                webrtc.isScreenSharing ? handleStopScreenShare : handleRequestScreenShare
              }
              onLeave={handleLeave}
              canShare={canRequestShare || webrtc.isScreenSharing}
              {...qualityControls}
              onDebugReport={() => void openDebugReport()}
              isSharer={isLocalSharing}
              hasPeer={!!peerName}
              peerDisplayName={peerName ?? undefined}
              hasScreenAudio={hasScreenAudio && !isLocalSharing}
              screenAudioVolume={screenAudioVolume}
              onScreenAudioVolumeChange={setScreenAudioVolume}
              menuItems={menuItems}
              onReact={isCallActive ? handleSendReaction : undefined}
              chat={{
                open: isSidebarOpen,
                unread: unreadMessages,
                onToggle: () => setIsSidebarOpen((open) => !open),
              }}
            />
          </div>
        </main>

        {/* People and chat — docked and resizable on a desk, a drawer on a
            tablet, a sheet on a phone. `inert` while closed, so a hidden
            panel cannot hold focus or be tabbed into. Nothing is unmounted:
            the peer's audio plays from inside it. */}
        <aside className="room-side" aria-label="People and chat" inert={!isSidebarOpen}>
          {/* Resize handle on the LEFT edge — pulling left grows the panel
              (and shrinks the stage), pulling right does the inverse. Width
              persists in localStorage. While dragging, the open/close
              transition is suppressed so tracking feels 1:1. */}
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth}
            onMouseDown={handleSidebarResizeStart}
            className="room-side__handle"
          />
          <div className="room-side__inner">
            <Sidebar
              localStream={webrtc.localStream}
              remoteStream={webrtc.remoteCameraStream}
              remoteDisplayName={peerName}
              localDisplayName={user.username}
              peerHasLeft={peerHasLeft}
              onSendMessage={handleSendMessage}
              peerVolume={peerVolume}
              peerIsMuted={!!peerMediaState?.isMuted}
              peerIsCameraOff={peerMediaState ? !peerMediaState.isCameraOn : false}
              localIsMuted={isMuted}
              localIsCameraOff={!isCameraOn}
              isPeerTyping={isPeerTyping}
              peerTypingName={peerTypingName}
              onLocalTyping={handleLocalTyping}
              foldTiles={stageShowsPeer}
              onClose={() => setIsSidebarOpen(false)}
            />
          </div>
        </aside>
        <div className="room-scrim" aria-hidden="true" onClick={() => setIsSidebarOpen(false)} />
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* InviteCard — what the stage shows while you wait for someone.   */
/* One link, one person: make it, copy it, watch it count down.    */
/* ────────────────────────────────────────────────────────────── */

function InviteCard({
  inviteUrl,
  isGenerating,
  copied,
  timeRemaining,
  onGenerate,
  onCopy,
}: {
  inviteUrl: string | null;
  isGenerating: boolean;
  copied: boolean;
  timeRemaining: string | null;
  onGenerate: () => void;
  onCopy: () => void;
}) {
  const copyRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (copied) sparkle(copyRef.current);
  }, [copied]);

  return (
    <>
      <Lights together={false} size={88} />
      <h2>Waiting for someone</h2>
      <p>Send a link to the one person you want in here. It works once and lasts 15 minutes.</p>
      {inviteUrl ? (
        <m.div
          className="invite-card"
          initial={{ opacity: 0, y: 14, scale: 0.97 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 320, damping: 24 }}
        >
          <div className="invite-ticket">
            <div className="invite-ticket__label">Session link</div>
            <ScrambleText text={inviteUrl} className="invite-ticket__url" />
            {timeRemaining && (
              <div className="invite-ticket__meta">
                {timeRemaining === 'Expired' ? 'Expired.' : <>Expires in <span className="tabular">{timeRemaining}</span>.</>}{' '}
                Works once.
              </div>
            )}
          </div>
          <div className="invite-card__row">
            <Button
              ref={copyRef}
              variant="primary"
              icon={copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
              onClick={onCopy}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </div>
        </m.div>
      ) : (
        <Button
          variant="primary"
          size="lg"
          magnetic
          icon={<LinkIcon size={19} />}
          onClick={onGenerate}
          loading={isGenerating}
          disabled={isGenerating}
        >
          {isGenerating ? 'Making a link…' : 'Invite someone'}
        </Button>
      )}
    </>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* WatchUrlPrompt — "what should we watch?" Parses YouTube URLs /  */
/* IDs upstream; this only collects the text and flags what        */
/* clearly is not a YouTube link before anything is sent.          */
/* ────────────────────────────────────────────────────────────── */

function WatchUrlPrompt({
  isOpen,
  onSubmit,
  onCancel,
}: {
  isOpen: boolean;
  onSubmit: (rawUrl: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');
  const trimmed = value.trim();
  const looksWrong = trimmed.length > 0 && !extractYouTubeVideoId(trimmed);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onCancel}
      title="Watch a video together"
      description="Paste a YouTube link or video ID. Play, pause and seeking stay in sync for both of you."
      width={500}
      footer={
        <>
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <Button variant="primary" type="submit" form="watch-form" icon={<PlayIcon size={18} />} disabled={!trimmed}>
            Start watching
          </Button>
        </>
      }
    >
      <form
        id="watch-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (!trimmed) return;
          onSubmit(trimmed);
          setValue('');
        }}
      >
        <TextField
          label="YouTube link"
          value={value}
          onValueChange={setValue}
          placeholder="https://www.youtube.com/watch?v=…"
          inputMode="url"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          data-autofocus=""
          problem={looksWrong ? 'That doesn’t look like a YouTube link.' : null}
        />
      </form>
    </Modal>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* FloatingReactions — emoji that rise from the bottom of the room */
/* and fade. Yours float up on the right in amber light, theirs on  */
/* the left in teal. Each flight path is generated from its id, so  */
/* two at once never trace the same line.                           */
/* ────────────────────────────────────────────────────────────── */

function FloatingReactions({ reactions, myName }: { reactions: FloatingReactionData[]; myName: string }) {
  return (
    <div className="reactions" role="status" aria-live="polite">
      {reactions.map((r) => (
        <FloatingReaction key={r.id} reaction={r} own={r.from === myName} />
      ))}
    </div>
  );
}

function FloatingReaction({ reaction, own }: { reaction: FloatingReactionData; own: boolean }) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Deterministic per reaction: a tiny hash of the id picks the path.
    const rand = (salt: number) => {
      const x = Math.sin(reaction.id * 12.9898 + salt * 78.233) * 43758.5453;
      return x - Math.floor(x);
    };
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.animate([{ opacity: 0 }, { opacity: 1, offset: 0.15 }, { opacity: 1, offset: 0.7 }, { opacity: 0 }], {
        duration: 2200,
        fill: 'forwards',
      });
      return;
    }
    const drift = (rand(1) - 0.5) * 160;
    const rise = 280 + rand(2) * 160;
    const spin = (rand(3) - 0.5) * 50;
    el.animate(
      [
        { transform: 'translate(0, 24px) scale(0.3) rotate(0deg)', opacity: 0 },
        { transform: `translate(${drift * 0.15}px, -26px) scale(1.3) rotate(${spin * 0.3}deg)`, opacity: 1, offset: 0.14 },
        { transform: `translate(${drift * 0.55}px, -${rise * 0.5}px) scale(1) rotate(${spin * 0.6}deg)`, opacity: 1, offset: 0.6 },
        { transform: `translate(${drift}px, -${rise}px) scale(0.85) rotate(${spin}deg)`, opacity: 0 },
      ],
      { duration: 2200, easing: 'cubic-bezier(0.2, 0.7, 0.3, 1)', fill: 'forwards' },
    );
  }, [reaction.id]);

  const jitter = ((reaction.id % 9) - 4) * 10;
  return (
    <span
      ref={ref}
      className="reaction"
      data-own={own ? '' : undefined}
      style={{ left: `calc(${own ? 62 : 38}% + ${jitter}px)`, opacity: 0 }}
      aria-label={`${reaction.from} reacted with ${reaction.emoji}`}
    >
      {reaction.emoji}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* ConnectionOverlay — covers the stage when ICE has hiccuped      */
/* (reconnecting) or given up (lost). Keeps the user oriented while */
/* the auto-recovery does its thing; for 'lost' there is also a     */
/* manual nudge so they don't have to leave and rejoin.             */
/* ────────────────────────────────────────────────────────────── */

function ConnectionOverlay({
  state,
  onIceRestart,
}: {
  state: 'reconnecting' | 'lost';
  onIceRestart?: () => void;
}) {
  const isLost = state === 'lost';
  return (
    <m.div
      className="conn-overlay"
      role="status"
      aria-live="assertive"
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      style={{ pointerEvents: isLost ? 'auto' : 'none' }}
    >
      <m.div
        className="sheet conn-overlay__card"
        initial={{ scale: 0.94, y: 10 }}
        animate={{ scale: 1, y: 0 }}
        style={{ pointerEvents: 'auto' }}
      >
        {isLost ? (
          <span className="status-card__icon" aria-hidden="true">
            <AlertIcon size={26} />
          </span>
        ) : (
          <span className="btn__spinner" aria-hidden="true" style={{ width: 34, height: 34, color: 'var(--amber)' }} />
        )}
        <h2>{isLost ? 'Connection lost' : 'Reconnecting…'}</h2>
        <p>
          {isLost
            ? 'Something interrupted the call. It’s still trying to recover, or you can give it a nudge.'
            : 'Hang on, finding a new path to them.'}
        </p>
        {isLost && onIceRestart && (
          <Button variant="primary" icon={<RefreshIcon size={18} />} onClick={onIceRestart}>
            Try again
          </Button>
        )}
      </m.div>
    </m.div>
  );
}
