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
import { useSenderHealth } from '../../hooks/useSenderHealth';
import {
  chooseOperatingPoint,
  initialBudgetState,
  minVideoBps,
  nextBudget,
  type BudgetState,
  sameOperatingPoint,
  type OperatingPoint,
} from '../../hooks/operatingPoint';
import { HEADROOM_SELECT } from '../../hooks/useUplinkEstimate';
import {
  initialLadderState,
  nextLadderState,
  withUserChoice,
  type LadderState,
} from '../../hooks/qualityLadder';
import { useQualityMonitor } from '../../hooks/useQualityMonitor';
import { useTalkingWhileMuted } from '../../hooks/useTalkingWhileMuted';
import { api } from '../../services/api';
import { Sidebar } from './Sidebar';
import { ScreenShareView } from './ScreenShareView';
import { ScreenShareRequest } from './ScreenShareRequest';
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
import { MediaControls } from '../Controls/MediaControls';
import { Loading } from '../common/Loading';
import { Toast } from '../common/Toast';
import {
  SectionTitle,
  TagSticker,
  StickerButton,
  BurstSticker,
  BackButton,
  Doodle,
} from '../manga';
import type {
  MediaState,
  ScreenShareQuality,
  QualityFeedback,
  QualityLevel,
  ContentMode,
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
  const [toast, setToast] = useState<{ message: string; type: 'info' | 'error' | 'warning' } | null>(null);
  const [isSidebarOpen, setIsSidebarOpen] = useState(true);

  // Stage gate. Mount lands here; PreflightLobby renders until the user
  // grants device permission and clicks JOIN, then we flip to 'joining'
  // (the existing async session-join flow) and finally 'live' once sessionId
  // is set. Routing back to lobby cancels and unmounts this whole component,
  // so we don't need an explicit reset path.
  const [stage, setStage] = useState<'preflight' | 'joining' | 'live'>('preflight');

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

  // Where automatic quality movement currently stands. `ceiling` is the user's
  // pick; `current` is what the link has earned underneath it.
  const [ladder, setLadder] = useState<LadderState>(() =>
    initialLadderState(screenShareQuality, Date.now()),
  );
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
  const screenShareQualityRef = useRef<ScreenShareQuality>(screenShareQuality);
  const localScreenStreamIdRef = useRef<string | null>(null);
  // True once the user manually picks a quality this session — suppresses the
  // automatic speed-test clamp so we never override a deliberate choice.
  const userOverrodeQualityRef = useRef(false);
  // Latest viewer verdict, fed into the ladder policy. A ref because it arrives
  // on the data channel between renders and must not itself trigger one.
  const viewerLevelRef = useRef<QualityLevel | null>(null);

  /**
   * Budget assumed before the estimator has an opinion.
   *
   * Start safe and climb, rather than start high and ratchet down. 2 Mbps lands
   * on a good 1080p24 for film and does not oversubscribe a modest uplink
   * during the ~9 s before the first real estimate; a faster link is back above
   * this within a couple of ladder probes. The reverse policy is what produced
   * the original complaint — the old default asked 4.1 Mbps of every link on
   * contact, and on anything slower that means overshoot, a standing queue, and
   * a picture that is soft and laggy at once.
   */
  const COLD_START_BUDGET_BPS = 2_000_000;

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

  const webrtc = useWebRTC({
    onIceCandidate: handleIceCandidate,
    onIceRestart: handleIceRestart,
  });

  useEffect(() => {
    webrtcRef.current = webrtc;
  }, [webrtc]);

  /**
   * Offer, and re-announce any screen share we are already running.
   *
   * One path for all four ways a peer can appear: they join, we join and find
   * them already there, they refresh, we refresh. Only the offerer acts, so it
   * is safe to call unconditionally.
   *
   * Media state deliberately does NOT belong here. It used to, and that was a
   * bug: the answering side returns early and so never told the peer whether
   * its mic was on. sendMediaState covers both roles.
   */
  const offerToPeer = useCallback(async () => {
    const currentSessionId = sessionIdRef.current;
    if (!isInitiatorRef.current || !currentSessionId) return;

    try {
      const offer = await webrtc.createOffer();
      await transportRef.current?.sendOffer(currentSessionId, offer);

      if (localScreenStreamIdRef.current) {
        await transportRef.current?.notifyScreenShareStarted(
          currentSessionId,
          localScreenStreamIdRef.current,
        );
      }
    } catch (err) {
      logger.error('[transport] Failed to create/send offer:', err);
    }
  }, [webrtc]);

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
    },
    onExistingPeer: (displayName) => {
      setPeerHasLeft(false);
      setPeerName(displayName);
      peerNameRef.current = displayName;
      // We're the side that just walked in, so nobody has heard our state yet
      // — and the preflight lobby may already have put us in muted /
      // camera-off (see the initial?.micOff handling in joinExistingSession).
      // Without this the peer renders default badges for us until our first
      // in-call toggle.
      void sendMediaState({ isMuted, isCameraOn });
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
    },
    onReconnecting: () => {
      setToast({ message: 'reconnecting…', type: 'warning' });
    },
    onReconnected: () => {
      setToast({ message: 'back online', type: 'info' });
    },
    onFatal: (reason) => {
      setError(reason);
      setToast({ message: reason, type: 'error' });
    },
    onPeerLeft: (displayName) => {
      setPeerHasLeft(true);
      setToast({ message: `${displayName || 'Peer'} has left the session`, type: 'warning' });
      setPeerName(null);
      peerNameRef.current = null;
      setPeerMediaState(null);
      setCurrentScreenSharer(null);
      webrtc.setRemoteScreenShareStreamId(null);
      webrtc.clearRemoteStreams();
      setInviteUrl(null);
      setInviteExpiry(null);
      setPeerVolume(100);
      setHasScreenAudio(false);
      setScreenAudioVolume(100);
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
      if (!currentScreenSharer) {
        setScreenShareRequest({ from: displayName, timestamp: Date.now() });
      }
    },
    onScreenShareResponse: async (approved) => {
      setIsWaitingForApproval(false);

      if (approved && sessionIdRef.current && pendingScreenShareRef.current) {
        const { stream, streamId } = pendingScreenShareRef.current;
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
      } else {
        if (pendingScreenShareRef.current) {
          pendingScreenShareRef.current.stream.getTracks().forEach((t) => t.stop());
          pendingScreenShareRef.current = null;
        }
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
    onReceiveQualityFeedback: (_displayName, feedback) => {
      setPeerQualityFeedback(feedback);
      if (feedback.level === 'poor' || feedback.level === 'critical') {
        setToast({
          message: `Viewer experiencing ${feedback.level} connection quality`,
          type: 'warning',
        });
      }
      // The viewer's verdict is one of two inputs to the ladder; the other is
      // our own encoder's health. Recorded here, acted on in the ladder effect
      // below, so both signals go through one policy rather than two racing
      // ad-hoc branches that could only ever move quality downward.
      viewerLevelRef.current = feedback.level;
    },
  });

  useEffect(() => {
    transportRef.current = transport;
  }, [transport]);

  const handleQualityFeedback = useCallback(async (feedback: QualityFeedback) => {
    if (sessionIdRef.current && transportRef.current) {
      try {
        await transportRef.current.sendQualityFeedback(sessionIdRef.current, feedback);
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
  );

  // Samples reset when sharing starts: eighteen seconds of camera-only readings
  // describe a completely different load than the one a share is about to place.
  const uplink = useUplinkEstimate(isCallActive, webrtc.isScreenSharing);
  const diagnostics = useTransportDiagnostics(isCallActive);

  /** What the link has earned, held across polls so it cannot decay. */
  const [budget, setBudget] = useState<BudgetState>(() =>
    initialBudgetState(COLD_START_BUDGET_BPS, Date.now()),
  );
  const budgetBps = budget.bps;

  /**
   * The operating point actually applied to the encoder.
   *
   * Derived, never stored: budget (measured, or a conservative cold start) plus
   * content mode plus the user's ceiling, run through the convex-hull chooser.
   * Six fixed rungs could not sit on that curve — which is why a 2 Mbps link
   * used to run 720p and leave a third of its uplink unused.
   */
  const operatingPoint = useMemo(
    () => chooseOperatingPoint(budgetBps, contentMode, ladder.applied),
    [budgetBps, contentMode, ladder.applied],
  );

  /*
   * True when the chooser is already at its floor — the link cannot fund a
   * bigger picture, so nothing the controller does will improve it. Derived
   * from the applied point rather than the budget so it stays correct however
   * the budget is represented.
   */
  const atBudgetFloor = operatingPoint.videoBps <= minVideoBps(operatingPoint.fps);

  // Sender health is the control input for BOTH the budget and the ladder.
  // Judged against the ceiling we actually set, so "is it getting its ask" is a
  // real question rather than a restatement of what we chose to send.
  const senderHealth = useSenderHealth(webrtc.isScreenSharing, operatingPoint.videoBps);

  /*
   * Advance the budget on every sender-health observation.
   *
   * `senderHealth.streak` is in the dependency list on purpose: it changes on
   * every poll, which is what lets the time-gated upward probe fire once per
   * poll rather than only when the verdict itself changes. The ladder effect
   * below depends on it for exactly the same reason.
   *
   * `capacityKnown` gates the estimate: a TCP-relay reading is a measured lower
   * bound, not a capacity measurement, and nextBudget's contract is that null
   * means "no opinion" rather than "no bandwidth".
   */
  useEffect(() => {
    setBudget((prev) =>
      nextBudget(prev, {
        now: Date.now(),
        estimateBps: uplink?.capacityKnown ? uplink.uplinkBps : null,
        health: senderHealth.health,
        // The only path by which the receiver's verdict reaches anything at all
        // on `auto`, where the preset ladder is inert (`auto` is not a rung).
        viewerUnhappy:
          viewerLevelRef.current === 'poor' || viewerLevelRef.current === 'critical',
        headroom: HEADROOM_SELECT,
        mode: contentMode,
        ceiling: ladder.applied,
      }),
    );
  }, [uplink, senderHealth.health, senderHealth.streak, contentMode, ladder.applied]);

  // A new share is a new load; carrying the old budget across would judge it by
  // the previous one's behaviour.
  useEffect(() => {
    if (!webrtc.isScreenSharing) setBudget(initialBudgetState(COLD_START_BUDGET_BPS, Date.now()));
  }, [webrtc.isScreenSharing]);

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
      return;
    }
    if (sameOperatingPoint(appliedPointRef.current, operatingPoint)) return;
    appliedPointRef.current = operatingPoint;
    webrtc.updateScreenShareQuality(operatingPoint).catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [operatingPoint, webrtc.isScreenSharing]);

  /**
   * Advance the ladder on every sender-health observation.
   *
   * Both directions, unlike everything this replaces. The old design only ever
   * stepped down and persisted the result, so one bad three-second window
   * pinned a user at the floor for every future session.
   */
  useEffect(() => {
    if (!webrtc.isScreenSharing) return;
    setLadder((prev) => {
      const next = nextLadderState(prev, {
        now: Date.now(),
        isSharing: true,
        senderHealth: senderHealth.health,
        viewerLevel: viewerLevelRef.current,
      });
      if (next.applied !== prev.applied) {
        // Deliberately NOT persisted. Only an explicit human pick is written to
        // storage; an automatic move is a response to this moment's link, not a
        // statement about what the user wants next week.
        screenShareQualityRef.current = next.applied;
        setScreenShareQuality(next.applied);
      }
      return next;
    });
  }, [senderHealth.health, senderHealth.streak, webrtc.isScreenSharing]);

  // CPU pressure needs a different answer than bandwidth pressure, and the
  // ladder deliberately refuses to act on it — say so rather than sitting on it.
  useEffect(() => {
    if (senderHealth.health !== 'cpu-bound') return;
    setToast({
      message: 'Encoder is CPU-limited — try a smaller share or close some tabs',
      type: 'warning',
    });
  }, [senderHealth.health]);

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
    userOverrodeQualityRef.current = true;
    setScreenShareQuality(quality);
    screenShareQualityRef.current = quality;
    setLadder(withUserChoice(quality, Date.now()));
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
   * ladder does on its own. The live share picks the new frame rate up through
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
      setIsWaitingForApproval(false);
      if (pendingScreenShareRef.current) {
        pendingScreenShareRef.current.stream.getTracks().forEach((t) => t.stop());
        pendingScreenShareRef.current = null;
      }
    }
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
    enabled: stage === 'live' && !showCheatSheet && !screenShareRequest,
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
        contextHint={isCreator ? 'starting a new session' : urlSessionId ? `joining session ${urlSessionId.slice(0, 6)}…` : undefined}
      />
    );
  }

  if (isJoining || (!sessionId && !error)) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center' }}>
          <Loading />
          <p className="hand" style={{ fontSize: 22, marginTop: 16, color: 'var(--purple)' }}>
            {urlSessionId ? 'joining session…' : 'creating session…'}
          </p>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '100vh' }}>
        <div style={{ textAlign: 'center', maxWidth: 480 }}>
          <BurstSticker bg="var(--orange)" rot={-4} w={240} h={150}>
            OOPS!
          </BurstSticker>
          <p className="hand" style={{ fontSize: 22, marginTop: 18 }}>{error}</p>
          <div className="row" style={{ justifyContent: 'center', gap: 14, marginTop: 24, flexWrap: 'wrap' }}>
            {urlSessionId && (
              <StickerButton
                color="pink"
                size="md"
                sfx="TAP!"
                onClick={() => {
                  // Bounce back to the preflight stage. The user can re-pick
                  // devices (USB plug changes are a real recovery path) and
                  // commit again from there.
                  setError(null);
                  hasTriedJoiningRef.current = false;
                  setStage('preflight');
                }}
              >
                TRY AGAIN
              </StickerButton>
            )}
            <BackButton onClick={() => navigate('/')}>lobby</BackButton>
          </div>
        </div>
      </div>
    );
  }

  const isLocalSharing = webrtc.isScreenSharing;
  const canRequestShare = !currentScreenSharer && !isWaitingForApproval;
  const timeRemaining = getInviteTimeRemaining();

  // Human-friendly label + color for the header pill. Kept in one place so
  // the overlay below can also key off the same uiConnState.
  const connDisplay = (() => {
    switch (uiConnState) {
      case 'connected':    return { label: 'connected',     color: 'var(--purple)' };
      case 'connecting':   return { label: 'connecting…',   color: 'var(--orange)' };
      case 'reconnecting': return { label: 'reconnecting…', color: 'var(--orange-deep)' };
      case 'lost':         return { label: 'connection lost', color: 'var(--orange-deep)' };
      case 'idle':
      default:             return { label: 'idle',          color: 'rgba(26,20,23,0.5)' };
    }
  })();

  return (
    <div
      style={{
        height: '100vh',
        display: 'flex',
        flexDirection: 'column',
        padding: 12,
        gap: 10,
        overflow: 'hidden',
        position: 'relative',
        zIndex: 1,
      }}
    >
      {screenShareRequest && (
        <ScreenShareRequest
          requesterName={screenShareRequest.from}
          onApprove={handleApproveScreenShare}
          onDeny={handleDenyScreenShare}
        />
      )}

      {toast && <Toast message={toast.message} type={toast.type} onClose={() => setToast(null)} />}

      <KeyboardShortcutsModal isOpen={showCheatSheet} onClose={() => setShowCheatSheet(false)} />

      {/* Watch Together URL prompt */}
      {showWatchPrompt && (
        <WatchUrlPrompt
          onSubmit={handleStartWatch}
          onCancel={() => setShowWatchPrompt(false)}
        />
      )}

      {/* Reactions: floating emojis drifting up from the bottom-centre,
          fading out. role="status" + aria-live="polite" so screen readers
          get a brief mention without interrupting. */}
      <div
        role="status"
        aria-live="polite"
        style={{
          position: 'fixed',
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'none',
          zIndex: 70,
          display: 'flex',
          justifyContent: 'center',
        }}
      >
        {reactions.map((r) => (
          <span
            key={r.id}
            aria-label={`${r.from} reacted with ${r.emoji}`}
            style={{
              position: 'absolute',
              bottom: 80,
              fontSize: 44,
              animation: 'reactionFloat 2200ms ease-out forwards',
              // Slight horizontal jitter per reaction so they don't stack —
              // hash the id into a deterministic offset.
              transform: `translateX(${((r.id % 9) - 4) * 16}px)`,
              userSelect: 'none',
            }}
          >
            {r.emoji}
          </span>
        ))}
      </div>

      {/* Reactions palette — small floating cluster bottom-right, always
          available when there's a peer. R keyboard shortcut also opens it
          (via the keyboard hook below). */}
      {isCallActive && (
        <ReactionsPalette onPick={handleSendReaction} />
      )}

      {/* Top header strip */}
      <div
        style={{
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 14px',
          background: 'var(--cream)',
          border: '3px solid var(--ink)',
          borderRadius: 12,
          boxShadow: '4px 4px 0 var(--ink)',
          flexWrap: 'wrap',
          transform: 'rotate(-0.3deg)',
        }}
      >
        <SectionTitle size={22} underline="pink">
          SESSION
        </SectionTitle>

        {peerName ? (
          <span
            style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              fontFamily: 'var(--font-body)',
              fontWeight: 700,
              fontSize: 14,
            }}
          >
            <Doodle kind="heart" size={18} color="var(--pink)" />
            <span style={{ color: 'var(--ink)' }}>{peerName}</span>
            <span
              className="hand"
              aria-live="polite"
              style={{ fontSize: 16, color: connDisplay.color }}
            >
              · {connDisplay.label}
            </span>
            {/* Quality badge — only when we have an active call to measure.
                During connecting/reconnecting/lost the connDisplay pill
                already tells the story, so we'd be adding noise. */}
            {isCallActive && (
              <ConnectionQualityBadge
                quality={qualityMonitor.quality}
                metrics={qualityMonitor.metrics}
              />
            )}
            {/* Watch Together launcher — small inline sticker. Disabled when
                someone is already screen-sharing (only one main-panel mode
                at a time) or when there's no peer yet. */}
            {isCallActive && !currentScreenSharer && !watchVideoId && (
              <button
                type="button"
                onClick={() => setShowWatchPrompt(true)}
                aria-label="watch a video together"
                title="watch a video together"
                style={{
                  marginLeft: 'auto',
                  padding: '4px 12px',
                  background: 'var(--purple)',
                  color: 'var(--cream)',
                  border: '2.5px solid var(--ink)',
                  boxShadow: '3px 3px 0 var(--ink)',
                  fontFamily: 'var(--font-sfx)',
                  fontSize: 12,
                  letterSpacing: 1,
                  cursor: 'pointer',
                  transform: 'rotate(-2deg)',
                }}
              >
                ♥ WATCH TOGETHER
              </button>
            )}
            {/* Background blur toggle — small sticker next to the call-quality
                badge. Only renders when we actually have a camera (no point
                if camera is off). aria-pressed tells SR it's a toggle. */}
            {!!cameraTrack && (
              <button
                type="button"
                onClick={() => setBgBlurEnabled((b) => !b)}
                aria-pressed={bgBlurEnabled}
                aria-label="background blur"
                title={blur.isLoading ? 'preparing blur…' : bgBlurEnabled ? 'blur on — click to turn off' : 'blur off'}
                disabled={blur.isLoading}
                style={{
                  marginLeft: isCallActive && !currentScreenSharer && !watchVideoId ? 0 : 'auto',
                  padding: '4px 10px',
                  background: bgBlurEnabled ? 'var(--purple)' : 'var(--cream)',
                  color: bgBlurEnabled ? 'var(--cream)' : 'var(--ink)',
                  border: '2.5px solid var(--ink)',
                  boxShadow: '3px 3px 0 var(--ink)',
                  fontFamily: 'var(--font-sfx)',
                  fontSize: 11,
                  letterSpacing: 1,
                  cursor: blur.isLoading ? 'wait' : 'pointer',
                  transform: 'rotate(2deg)',
                  opacity: blur.isLoading ? 0.6 : 1,
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 4,
                }}
              >
                <span aria-hidden="true">⊙</span>
                {blur.isLoading ? 'LOADING' : bgBlurEnabled ? 'BLUR ON' : 'BLUR'}
              </button>
            )}
          </span>
        ) : (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.6)' }}>
              waiting for a friend…
            </span>
            {inviteUrl ? (
              <>
                <a
                  href={inviteUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  title={inviteUrl}
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 12,
                    color: 'var(--ink)',
                    textDecoration: 'underline',
                    maxWidth: 200,
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}
                >
                  {inviteUrl.replace(/^https?:\/\//, '').substring(0, 32)}…
                </a>
                <button
                  type="button"
                  onClick={handleCopyInvite}
                  style={{
                    padding: '4px 10px',
                    background: inviteCopied ? 'var(--purple)' : 'var(--pink)',
                    color: inviteCopied ? 'var(--cream)' : 'var(--ink)',
                    border: '2.5px solid var(--ink)',
                    borderRadius: 999,
                    fontFamily: 'var(--font-sfx)',
                    fontSize: 12,
                    letterSpacing: 1,
                    cursor: 'pointer',
                    boxShadow: '2px 2px 0 var(--ink)',
                  }}
                >
                  {inviteCopied ? 'COPIED!' : 'COPY'}
                </button>
                {timeRemaining && (
                  <span className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.55)' }}>
                    {timeRemaining}
                  </span>
                )}
              </>
            ) : (
              <button
                type="button"
                onClick={handleGenerateInvite}
                disabled={isGeneratingInvite}
                style={{
                  padding: '4px 12px',
                  background: 'var(--purple)',
                  color: 'var(--cream)',
                  border: '2.5px solid var(--ink)',
                  borderRadius: 999,
                  fontFamily: 'var(--font-sfx)',
                  fontSize: 12,
                  letterSpacing: 1,
                  cursor: isGeneratingInvite ? 'not-allowed' : 'pointer',
                  boxShadow: '2px 2px 0 var(--ink)',
                  opacity: isGeneratingInvite ? 0.5 : 1,
                }}
              >
                {isGeneratingInvite ? 'GENERATING…' : 'GENERATE INVITE'}
              </button>
            )}
          </span>
        )}

        <span style={{ flex: 1 }} />

        <TagSticker color="cream" rot={2}>
          {user.tag}
        </TagSticker>
      </div>

      {/* Main content */}
      <div
        style={{
          flex: 1,
          display: 'flex',
          gap: 10,
          minHeight: 0,
          overflow: 'hidden',
        }}
      >
        {/* Screen share + controls */}
        <div
          style={{
            flex: 1,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            minWidth: 0,
            minHeight: 0,
          }}
        >
          <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
            {(uiConnState === 'reconnecting' || uiConnState === 'lost') && (
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
            />
            )}
          </div>

          <div style={{ flexShrink: 0 }}>
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
              screenShareQuality={screenShareQuality}
              onQualityChange={handleQualityChange}
              uplink={uplink}
              diagnostics={diagnostics}
              appliedPoint={webrtc.isScreenSharing ? operatingPoint : null}
              atBudgetFloor={atBudgetFloor}
              contentMode={contentMode}
              onContentModeChange={handleContentModeChange}
              isSharer={isLocalSharing}
              hasPeer={!!peerName}
              peerDisplayName={peerName ?? undefined}
              peerVolume={peerVolume}
              onPeerVolumeChange={setPeerVolume}
              hasScreenAudio={hasScreenAudio && !isLocalSharing}
              screenAudioVolume={screenAudioVolume}
              onScreenAudioVolumeChange={setScreenAudioVolume}
            />
          </div>
        </div>

        {/* Sidebar (cameras + chat) — collapsible on mobile, resizable on desktop.
            display: none used to wink the sidebar out instantly (no animation
            possible on `display`). Switching to width + opacity + transform
            lets the transition actually play. aria-hidden tracks the collapsed
            state so screen readers skip the hidden subtree.

            Resize handle sits on the LEFT edge — pulling left grows the
            sidebar (and shrinks the screen-share panel), pulling right does
            the inverse. Width persists in localStorage. While the user is
            actively dragging we suppress the open/close transition so
            tracking feels 1:1. */}
        <div style={{ position: 'relative', display: 'flex' }}>
          <div
            role="separator"
            aria-orientation="vertical"
            aria-label="Resize sidebar"
            aria-valuemin={SIDEBAR_MIN}
            aria-valuemax={SIDEBAR_MAX}
            aria-valuenow={sidebarWidth}
            onMouseDown={handleSidebarResizeStart}
            className="sidebar-resize-handle"
            style={{
              width: 6,
              flexShrink: 0,
              cursor: 'col-resize',
              alignSelf: 'stretch',
              // Hover-only visual; we paint a faint ink line via CSS so
              // it doesn't compete with the content when idle.
              background: isResizingSidebar ? 'var(--purple)' : 'transparent',
              transition: 'background 120ms ease',
              display: isSidebarOpen ? 'block' : 'none',
            }}
          />
        <div
          aria-hidden={!isSidebarOpen}
          style={{
            width: isSidebarOpen ? sidebarWidth : 0,
            flexShrink: 0,
            minHeight: 0,
            overflow: 'hidden',
            transition: isResizingSidebar
              ? 'none'
              : 'width 280ms cubic-bezier(.34,1.5,.64,1), transform 280ms ease, opacity 220ms ease',
            transform: isSidebarOpen ? 'translateX(0)' : 'translateX(40px)',
            opacity: isSidebarOpen ? 1 : 0,
            pointerEvents: isSidebarOpen ? 'auto' : 'none',
          }}
        >
          <Sidebar
            localStream={webrtc.localStream}
            remoteStream={webrtc.remoteCameraStream}
            remoteDisplayName={peerName}
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
          />
        </div>
        </div>
      </div>

      {/* Mobile sidebar toggle (visible only on narrow viewports via media query) */}
      <button
        type="button"
        onClick={() => setIsSidebarOpen((open) => !open)}
        className="mobile-sidebar-toggle"
        title={isSidebarOpen ? 'hide sidebar' : 'show sidebar'}
        style={{
          position: 'fixed',
          bottom: 24,
          right: 16,
          zIndex: 60,
          width: 50,
          height: 50,
          borderRadius: '50%',
          background: 'var(--pink)',
          border: '3px solid var(--ink)',
          boxShadow: '4px 4px 0 var(--ink)',
          cursor: 'pointer',
          display: 'none',
          alignItems: 'center',
          justifyContent: 'center',
          padding: 0,
        }}
      >
        <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 18, color: 'var(--ink)' }}>
          {isSidebarOpen ? '×' : '☰'}
        </span>
        {/* Unread chat counter — only rendered when collapsed AND there are
            actually unread messages. Capped at "9+" so the dot doesn't grow
            wide enough to throw off the FAB silhouette. */}
        {!isSidebarOpen && unreadMessages > 0 && (
          <span
            aria-label={`${unreadMessages} unread message${unreadMessages === 1 ? '' : 's'}`}
            style={{
              position: 'absolute',
              top: -4,
              right: -4,
              minWidth: 22,
              height: 22,
              padding: '0 5px',
              borderRadius: 999,
              background: 'var(--orange-deep, var(--orange))',
              color: 'var(--cream)',
              border: '2.5px solid var(--ink)',
              fontFamily: 'var(--font-sfx)',
              fontSize: 11,
              letterSpacing: 0.5,
              display: 'grid',
              placeItems: 'center',
              transform: 'rotate(8deg)',
            }}
          >
            {unreadMessages > 9 ? '9+' : unreadMessages}
          </span>
        )}
      </button>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* ConnectionOverlay — semi-opaque manga-panel that floats over the */
/* screen-share area when ICE has hiccuped (reconnecting) or given   */
/* up (lost). Keeps the user oriented while the auto-recovery does   */
/* its thing. For 'lost' we also expose a manual "try again" button  */
/* so they don't have to leave & rejoin if the auto-ICE-restart      */
/* didn't take.                                                       */
/* ────────────────────────────────────────────────────────────── */

/* ────────────────────────────────────────────────────────────── */
/* WatchUrlPrompt — modal that asks "what should we watch?" and    */
/* hands the raw input back. Parses YouTube URLs / IDs upstream so */
/* this stays a dumb UI.                                            */
/* ────────────────────────────────────────────────────────────── */

function WatchUrlPrompt({
  onSubmit,
  onCancel,
}: {
  onSubmit: (rawUrl: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);

  return (
    <div
      role="dialog"
      aria-modal="true"
      onClick={onCancel}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 20, 23, 0.6)',
        backdropFilter: 'blur(2px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 9000,
        padding: 24,
      }}
    >
      <form
        onClick={(e) => e.stopPropagation()}
        onSubmit={(e) => {
          e.preventDefault();
          if (value.trim()) onSubmit(value.trim());
        }}
        style={{
          background: 'var(--cream)',
          border: '4px solid var(--ink)',
          boxShadow: '8px 8px 0 var(--ink)',
          padding: '24px 28px',
          maxWidth: 480,
          width: '100%',
          transform: 'rotate(-0.5deg)',
        }}
      >
        <div style={{ fontFamily: 'var(--font-sfx)', fontSize: 24, letterSpacing: 1, color: 'var(--purple)' }}>
          WATCH TOGETHER
        </div>
        <p className="hand" style={{ fontSize: 18, marginTop: 8, color: 'rgba(26,20,23,0.7)' }}>
          paste a youtube link (or just the video id) — peer joins in sync.
        </p>
        <input
          autoFocus
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="https://www.youtube.com/watch?v=…"
          style={{
            width: '100%',
            marginTop: 16,
            padding: '10px 14px',
            border: '3px solid var(--ink)',
            background: 'var(--cream-deep)',
            fontFamily: 'var(--font-body)',
            fontSize: 14,
            color: 'var(--ink)',
            outline: 'none',
          }}
        />
        <div className="row" style={{ marginTop: 18, gap: 12, justifyContent: 'flex-end' }}>
          <BackButton onClick={onCancel}>nevermind</BackButton>
          <button
            type="submit"
            disabled={!value.trim()}
            style={{
              padding: '8px 18px',
              background: value.trim() ? 'var(--pink)' : 'rgba(255,79,163,0.4)',
              border: '3px solid var(--ink)',
              boxShadow: '4px 4px 0 var(--ink)',
              fontFamily: 'var(--font-sfx)',
              fontSize: 16,
              letterSpacing: 1,
              cursor: value.trim() ? 'pointer' : 'not-allowed',
              transform: 'rotate(-1deg)',
            }}
          >
            START!
          </button>
        </div>
      </form>
    </div>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* ReactionsPalette — small floating cluster of 6 emoji that fly   */
/* up when clicked. Bottom-right corner of the screen, so it       */
/* doesn't crowd the centre content. Always reachable.             */
/* ────────────────────────────────────────────────────────────── */

const REACTION_EMOJI = ['🩷', '😂', '🔥', '👏', '👍', '🤯'];

function ReactionsPalette({ onPick }: { onPick: (emoji: string) => void }) {
  return (
    <div
      style={{
        position: 'fixed',
        bottom: 90,
        right: 16,
        zIndex: 65,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        background: 'var(--cream)',
        border: '3px solid var(--ink)',
        boxShadow: '4px 4px 0 var(--ink)',
        padding: 6,
        transform: 'rotate(-2deg)',
      }}
    >
      {REACTION_EMOJI.map((emoji) => (
        <button
          key={emoji}
          type="button"
          onClick={() => onPick(emoji)}
          aria-label={`react with ${emoji}`}
          style={{
            background: 'transparent',
            border: 'none',
            fontSize: 22,
            cursor: 'pointer',
            padding: '2px 6px',
            transition: 'transform 120ms ease',
          }}
          onMouseEnter={(e) => {
            e.currentTarget.style.transform = 'scale(1.4) rotate(-6deg)';
          }}
          onMouseLeave={(e) => {
            e.currentTarget.style.transform = 'scale(1)';
          }}
        >
          {emoji}
        </button>
      ))}
    </div>
  );
}

function ConnectionOverlay({
  state,
  onIceRestart,
}: {
  state: 'reconnecting' | 'lost';
  onIceRestart?: () => void;
}) {
  const isLost = state === 'lost';
  return (
    <div
      role="status"
      aria-live="assertive"
      style={{
        position: 'absolute',
        inset: 0,
        zIndex: 5,
        display: 'grid',
        placeItems: 'center',
        background: 'rgba(26, 20, 23, 0.55)',
        backdropFilter: 'blur(2px)',
        pointerEvents: isLost ? 'auto' : 'none',
      }}
    >
      <div
        style={{
          background: 'var(--cream)',
          border: '4px solid var(--ink)',
          boxShadow: '6px 6px 0 var(--ink)',
          padding: '20px 28px',
          textAlign: 'center',
          maxWidth: 420,
          transform: 'rotate(-1deg)',
          pointerEvents: 'auto',
        }}
      >
        <div
          style={{
            fontFamily: 'var(--font-sfx)',
            fontSize: 32,
            letterSpacing: 2,
            color: isLost ? 'var(--orange-deep)' : 'var(--orange)',
          }}
        >
          {isLost ? 'CONNECTION LOST' : 'RECONNECTING…'}
        </div>
        <div
          className="hand"
          style={{ fontSize: 18, marginTop: 10, color: 'rgba(26,20,23,0.75)' }}
        >
          {isLost
            ? 'something interrupted the call. trying to recover — or you can give it a nudge.'
            : 'hang tight — finding a new path to your friend.'}
        </div>
        {isLost && onIceRestart && (
          <button
            type="button"
            onClick={onIceRestart}
            style={{
              marginTop: 16,
              fontFamily: 'var(--font-sfx)',
              fontSize: 18,
              letterSpacing: 1,
              padding: '8px 18px',
              background: 'var(--pink)',
              color: 'var(--ink)',
              border: '3px solid var(--ink)',
              boxShadow: '4px 4px 0 var(--ink)',
              cursor: 'pointer',
              transform: 'rotate(-1deg)',
            }}
          >
            TRY AGAIN
          </button>
        )}
      </div>
    </div>
  );
}
