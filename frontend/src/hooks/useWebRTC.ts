import { logger } from '../services/logger';
import { useState, useCallback, useRef, useEffect } from 'react';
import { webrtcService, type WebRTCEventHandlers } from '../services/webrtcService';
import { api } from '../services/api';
import type { OperatingPoint } from './operatingPoint';

// Receiver-side playout buffer target (ms). Lower = tighter broadcaster↔viewer
// sync; higher = more cushion against jitter (fewer freezes). This is the #1
// latency knob — calibrate against measured freezeCount / jitterBufferDelay.
const JITTER_BUFFER_TARGET_MS = 250;

type UseWebRTCOptions = {
  onIceCandidate: (candidate: string) => void;
  onIceRestart?: () => void;
  /**
   * The captured screen ended without going through our stop button — the
   * browser's own "Stop sharing" bar, most often. Must be stable across
   * renders: it feeds `initialize`, whose dependencies decide whether the peer
   * connection is rebuilt.
   */
  onScreenShareEnded?: () => void;
};

export function useWebRTC(options: UseWebRTCOptions | ((candidate: string) => void)) {
  // Support both old API (function) and new API (options object)
  const { onIceCandidate, onIceRestart, onScreenShareEnded } = typeof options === 'function'
    ? { onIceCandidate: options, onIceRestart: undefined, onScreenShareEnded: undefined }
    : options;
  const [localStream, setLocalStream] = useState<MediaStream | null>(null);
  const [localScreenStream, setLocalScreenStream] = useState<MediaStream | null>(null);
  const [remoteCameraStream, setRemoteCameraStream] = useState<MediaStream | null>(null);
  const [remoteScreenStream, setRemoteScreenStream] = useState<MediaStream | null>(null);
  const [connectionState, setConnectionState] = useState<RTCPeerConnectionState>('new');
  const [isScreenSharing, setIsScreenSharing] = useState(false);

  // Track remote streams by ID
  const remoteStreamsRef = useRef<Map<string, MediaStream>>(new Map());
  const remoteScreenStreamIdRef = useRef<string | null>(null);

  // Refs for incremental stream building
  const remoteScreenStreamRef = useRef<MediaStream | null>(null);
  const remoteCameraStreamRef = useRef<MediaStream | null>(null);

  const initialize = useCallback(async () => {
    logger.debug('[useWebRTC] initialize() called');
    const iceConfig = await api.getIceServers();
    logger.debug('[useWebRTC] ICE config received, setting up handlers');

    const handlers: WebRTCEventHandlers = {
      onTrack: (event) => {
        const stream = event.streams[0];
        if (!stream) {
          logger.debug('Track received without stream:', event.track.kind, event.track.id);
          return;
        }

        const streamId = stream.id;
        const track = event.track;

        // Tighten the receiver playout buffer for closer broadcaster↔viewer sync.
        // jitterBufferTarget (ms) is the modern API; playoutDelayHint (seconds) is
        // the older Chrome fallback. Both are hints — the browser clamps to what
        // the link can sustain, so this can't starve a genuinely jittery path.
        // Plain optional-prop shape (not intersected with RTCRtpReceiver): the
        // intersection makes TS collapse the `in`-narrowed else branch to `never`.
        const receiver = event.receiver as {
          jitterBufferTarget?: number;
          playoutDelayHint?: number;
        };
        try {
          if ('jitterBufferTarget' in receiver) {
            receiver.jitterBufferTarget = JITTER_BUFFER_TARGET_MS;
          } else if ('playoutDelayHint' in receiver) {
            receiver.playoutDelayHint = JITTER_BUFFER_TARGET_MS / 1000;
          }
        } catch {
          /* hint not supported here — ignore */
        }

        // Classify screen-vs-camera by the SignalR-signaled stream id. NOTE:
        // contentHint is NOT transmitted to the receiver, so the old
        // `track.contentHint === 'detail'` check was always false here (dead code).
        // The sharer announces its screen stream id over SignalR, which
        // setRemoteScreenShareStreamId stores in remoteScreenStreamIdRef.
        const isScreenShare = streamId === remoteScreenStreamIdRef.current;

        logger.debug('[WebRTC] Track received:', {
          kind: track.kind,
          id: track.id,
          streamId: streamId,
          contentHint: track.contentHint,
          isScreenShare: isScreenShare,
          enabled: track.enabled,
          muted: track.muted,
          readyState: track.readyState
        });

        // Safari quirk: tracks frequently arrive with `muted: true` and only flip
        // to unmuted when the first packet of payload reaches the decoder. The
        // <audio> element won't produce sound while muted=true, so we re-attach
        // the srcObject on the unmute event to nudge the element into playing.
        // This is harmless in Chrome (where muted is almost always false at arrival).
        track.addEventListener('unmute', () => {
          logger.debug(`[WebRTC] Track unmuted: kind=${track.kind} id=${track.id}`);
        });

        // Backstop for a screen share that goes away without the peer saying so.
        // ScreenShareStopped is still the signal we act on — it is the one that
        // also clears the sharer's NAME — but nothing used to notice a dead
        // inbound track at all, so a lost stop frame left the viewer staring at
        // the last decoded frame with no way to tell it from a still window.
        //
        // 'ended' only. NOT 'mute': that fires routinely on brief packet loss,
        // and a freeze that is really congestion is already scored by
        // useQualityMonitor rather than treated as the end of the share.
        track.addEventListener('ended', () => {
          if (streamId !== remoteScreenStreamIdRef.current) return;
          logger.warn('[WebRTC] remote screen track ended — clearing the frozen frame');
          remoteScreenStreamRef.current = null;
          remoteScreenStreamIdRef.current = null;
          setRemoteScreenStream(null);
        });

        // Store stream reference
        remoteStreamsRef.current.set(streamId, stream);

        if (isScreenShare) {
          // Screen share - add to existing or create new ref immediately
          if (!remoteScreenStreamRef.current) {
            remoteScreenStreamRef.current = new MediaStream();
          }
          if (!remoteScreenStreamRef.current.getTracks().some(t => t.id === track.id)) {
            remoteScreenStreamRef.current.addTrack(track);
            // Create new MediaStream for React state (triggers re-render)
            setRemoteScreenStream(new MediaStream(remoteScreenStreamRef.current.getTracks()));
          }
          // Update the stream ID ref if not already set
          if (!remoteScreenStreamIdRef.current) {
            remoteScreenStreamIdRef.current = streamId;
          }
        } else {
          // Camera - add to existing or create new ref immediately
          if (!remoteCameraStreamRef.current) {
            remoteCameraStreamRef.current = new MediaStream();
          }
          if (!remoteCameraStreamRef.current.getTracks().some(t => t.id === track.id)) {
            remoteCameraStreamRef.current.addTrack(track);
            // Create new MediaStream for React state (triggers re-render)
            const newStream = new MediaStream(remoteCameraStreamRef.current.getTracks());
            logger.debug('[WebRTC] Camera stream updated:', {
              trackAdded: track.kind,
              totalTracks: newStream.getTracks().length,
              tracks: newStream.getTracks().map(t => ({ kind: t.kind, enabled: t.enabled }))
            });
            setRemoteCameraStream(newStream);
          }
        }
      },
      onIceCandidate: (candidate) => {
        logger.debug('[useWebRTC] ICE candidate handler called, forwarding to SessionRoom');
        onIceCandidate(JSON.stringify(candidate));
      },
      onConnectionStateChange: (state) => {
        logger.debug('Connection state:', state);
        setConnectionState(state);
      },
      onIceRestart: () => {
        logger.debug('[useWebRTC] ICE restart requested');
        onIceRestart?.();
      },
      onScreenShareEnded: () => {
        logger.debug('[useWebRTC] captured screen ended outside our stop button');
        onScreenShareEnded?.();
      },
    };

    webrtcService.setHandlers(handlers);
    await webrtcService.initialize(iceConfig);
  }, [onIceCandidate, onIceRestart, onScreenShareEnded]);

  // Note: refs are updated immediately in onTrack handler, no useEffect needed

  const getUserMedia = useCallback(async (video = true, audio = true) => {
    const stream = await webrtcService.getUserMedia(video, audio);
    setLocalStream(stream);
    return stream;
  }, []);

  /**
   * Hand a stream that was acquired outside the hook (e.g. by PreflightLobby)
   * to the peer connection. Mirrors getUserMedia's "set localStream + add
   * tracks to PC" but without the getUserMedia call itself.
   */
  const attachLocalStream = useCallback((stream: MediaStream) => {
    webrtcService.attachLocalStream(stream);
    setLocalStream(stream);
  }, []);

  const replaceVideoTrack = useCallback(async (newTrack: MediaStreamTrack | null) => {
    const ok = await webrtcService.replaceVideoTrack(newTrack);
    // Re-fetch the (mutated) stream so React state lines up with the
    // service-owned MediaStream.
    setLocalStream(webrtcService.getLocalStream());
    return ok;
  }, []);

  // Capture screen WITHOUT adding to peer connection (for permission flow).
  // `hasAudio` lets the caller surface a UX hint when the browser didn't capture
  // any audio (Safari's most common screen-share gotcha — see webrtcService.captureScreen).
  const captureScreen = useCallback(async (point: OperatingPoint) => {
    const { stream, streamId, hasAudio } = await webrtcService.captureScreen(point);
    return { stream, streamId, hasAudio };
  }, []);

  // Add captured screen to peer connection (after permission granted)
  const addScreenShareTracks = useCallback(async (stream: MediaStream, point: OperatingPoint) => {
    await webrtcService.addScreenShareTracks(stream, point);
    setIsScreenSharing(true);
    setLocalScreenStream(stream);
  }, []);

  // Legacy method - captures AND adds tracks
  const startScreenShare = useCallback(async (point: OperatingPoint) => {
    const { stream, streamId, needsRenegotiation } = await webrtcService.getDisplayMedia(point);
    setIsScreenSharing(true);
    setLocalScreenStream(stream);
    return { stream, streamId, needsRenegotiation };
  }, []);

  const stopScreenShare = useCallback(async () => {
    const needsRenegotiation = await webrtcService.stopScreenShare();
    setIsScreenSharing(false);
    setLocalScreenStream(null);
    return needsRenegotiation;
  }, []);

  /**
   * Change quality on the live screen-share sender without renegotiation.
   * Returns false if there's nothing to update (caller should fall back
   * to stop+capture+addTracks for cases like browsers that won't honor
   * setParameters on a getDisplayMedia sender).
   */
  const updateScreenShareQuality = useCallback(async (point: OperatingPoint) => {
    return webrtcService.updateScreenShareQuality(point);
  }, []);

  // Called when signaling notifies us of remote screen share stream ID
  const setRemoteScreenShareStreamId = useCallback((streamId: string | null) => {
    logger.debug('Setting remote screen share stream ID:', streamId);
    remoteScreenStreamIdRef.current = streamId;

    if (streamId) {
      // Check if we already have this stream (may have been misclassified as camera)
      const existingStream = remoteStreamsRef.current.get(streamId);
      if (existingStream) {
        // Move to screen share stream - update ref first
        remoteScreenStreamRef.current = new MediaStream(existingStream.getTracks());
        setRemoteScreenStream(remoteScreenStreamRef.current);

        // Remove from camera stream if it was there (misclassified due to race condition)
        if (remoteCameraStreamRef.current) {
          const camTracks = remoteCameraStreamRef.current.getTracks();
          const streamTrackIds = new Set(existingStream.getTracks().map(t => t.id));
          const remainingTracks = camTracks.filter(t => !streamTrackIds.has(t.id));
          if (remainingTracks.length !== camTracks.length) {
            // Update ref first, then state
            remoteCameraStreamRef.current = remainingTracks.length > 0
              ? new MediaStream(remainingTracks)
              : null;
            setRemoteCameraStream(remoteCameraStreamRef.current);
          }
        }
      }
    } else {
      remoteScreenStreamRef.current = null;
      setRemoteScreenStream(null);
    }
  }, []);

  /**
   * Give up on VP9 for this share, if we have not already.
   *
   * Returns true when the caller must renegotiate — the preference only affects
   * the NEXT offer, so nothing changes until one is exchanged. Synchronous
   * because there is nothing to await: it reorders a list and sets a flag.
   */
  const downgradeScreenCodec = useCallback(() => {
    return webrtcService.downgradeScreenCodec();
  }, []);

  const createOffer = useCallback(async () => {
    return webrtcService.createOffer();
  }, []);

  const createIceRestartOffer = useCallback(async () => {
    return webrtcService.createIceRestartOffer();
  }, []);

  const createAnswer = useCallback(async () => {
    return webrtcService.createAnswer();
  }, []);

  const setRemoteDescription = useCallback(async (sdp: string) => {
    return webrtcService.setRemoteDescription(sdp);
  }, []);

  const addIceCandidate = useCallback(async (candidate: string) => {
    return webrtcService.addIceCandidate(candidate);
  }, []);

  const getSignalingState = useCallback(() => webrtcService.getSignalingState(), []);

  const isMakingOffer = useCallback(() => webrtcService.isMakingOffer(), []);

  const toggleAudio = useCallback((enabled: boolean) => {
    webrtcService.toggleAudio(enabled);
  }, []);

  const toggleVideo = useCallback(async (enabled: boolean) => {
    // toggleVideo is now async because turning the camera back on requires
    // a fresh getUserMedia call. Existing callers (useMediaDevices) fire
    // and forget — that's fine, we just don't surface the latency. When
    // we resume, the localStream reference itself is the same MediaStream
    // (we mutate its tracks), so React state is already in sync. We still
    // bump the state ref with a new array-wrapper so consumers that
    // depend on stream identity see a re-render.
    await webrtcService.toggleVideo(enabled);
    const stream = webrtcService.getLocalStream();
    setLocalStream(stream);
  }, []);

  // Clear remote streams when peer leaves (without closing local connection)
  const clearRemoteStreams = useCallback(() => {
    logger.debug('[WebRTC] Clearing remote streams');
    setRemoteCameraStream(null);
    setRemoteScreenStream(null);
    remoteCameraStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    remoteStreamsRef.current.clear();
    remoteScreenStreamIdRef.current = null;
  }, []);

  const close = useCallback(() => {
    webrtcService.close();
    setLocalStream(null);
    setLocalScreenStream(null);
    setRemoteCameraStream(null);
    setRemoteScreenStream(null);
    setIsScreenSharing(false);
    remoteCameraStreamRef.current = null;
    remoteScreenStreamRef.current = null;
    remoteStreamsRef.current.clear();
    remoteScreenStreamIdRef.current = null;
  }, []);

  useEffect(() => {
    return () => {
      close();
    };
  }, [close]);

  return {
    localStream,
    localScreenStream,
    remoteCameraStream,
    remoteScreenStream,
    // Keep remoteStream for backward compatibility (alias to remoteCameraStream)
    remoteStream: remoteCameraStream,
    connectionState,
    isScreenSharing,
    initialize,
    getUserMedia,
    attachLocalStream,
    replaceVideoTrack,
    captureScreen,
    addScreenShareTracks,
    startScreenShare,
    stopScreenShare,
    updateScreenShareQuality,
    setRemoteScreenShareStreamId,
    createOffer,
    downgradeScreenCodec,
    createIceRestartOffer,
    createAnswer,
    setRemoteDescription,
    addIceCandidate,
    getSignalingState,
    isMakingOffer,
    toggleAudio,
    toggleVideo,
    clearRemoteStreams,
    close,
  };
}
