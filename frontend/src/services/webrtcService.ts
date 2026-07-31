import { logger } from './logger';
import { dataChannelService } from './dataChannelService';
import type { IceServerConfig, ScreenShareQuality, QualityPreset } from '../types';
import { QUALITY_PRESETS as QualityPresets } from '../types';

export type WebRTCEventHandlers = {
  onTrack?: (event: RTCTrackEvent) => void;
  onIceCandidate?: (candidate: RTCIceCandidate) => void;
  onConnectionStateChange?: (state: RTCPeerConnectionState) => void;
  onNegotiationNeeded?: () => void;
  onIceRestart?: () => void;
};

class WebRTCService {
  private peerConnection: RTCPeerConnection | null = null;
  private localStream: MediaStream | null = null;
  private screenStream: MediaStream | null = null;
  private screenStreamId: string | null = null;
  // Senders we created for the screen share, kept by reference so a live quality
  // switch can find them without an id-based lookup that drifts (the lookup miss
  // was what used to drop quality changes into the disruptive recapture path).
  private screenVideoSender: RTCRtpSender | null = null;
  private screenAudioSender: RTCRtpSender | null = null;
  private handlers: WebRTCEventHandlers = {};
  private pendingIceCandidates: RTCIceCandidateInit[] = [];
  private hasRemoteDescription = false;
  private disconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private iceRestartInProgress = false;
  // Perfect-negotiation: true only while we're building/applying our own offer.
  // Combined with signalingState, lets the receive side detect offer glare.
  private makingOffer = false;
  private static readonly DISCONNECT_TIMEOUT_MS = 5000; // 5 seconds before ICE restart

  async initialize(iceConfig: IceServerConfig): Promise<void> {
    const config: RTCConfiguration = {
      iceServers: iceConfig.iceServers.map(server => ({
        urls: server.urls,
        username: server.username,
        credential: server.credential,
      })),
    };

    this.peerConnection = new RTCPeerConnection(config);
    this.hasRemoteDescription = false;
    this.pendingIceCandidates = [];
    this.setupPeerConnectionHandlers();

    // Before any offer is created, so both channels land in the initial SDP and
    // never cost a renegotiation of their own. Both ends create their own side
    // (the channels are negotiated with fixed ids), so this runs identically
    // for offerer and answerer.
    dataChannelService.attach(this.peerConnection);
  }

  private setupPeerConnectionHandlers(): void {
    if (!this.peerConnection) return;

    this.peerConnection.ontrack = (event) => {
      this.handlers.onTrack?.(event);
    };

    this.peerConnection.onicecandidate = (event) => {
      logger.debug('[WebRTC Service] onicecandidate fired:', event.candidate ? 'has candidate' : 'null (gathering complete)');
      if (event.candidate) {
        logger.debug('[WebRTC Service] Calling handler for ICE candidate');
        this.handlers.onIceCandidate?.(event.candidate);
      }
    };

    this.peerConnection.onconnectionstatechange = () => {
      if (this.peerConnection) {
        this.handlers.onConnectionStateChange?.(this.peerConnection.connectionState);
      }
    };

    this.peerConnection.onnegotiationneeded = () => {
      this.handlers.onNegotiationNeeded?.();
    };

    this.peerConnection.onicegatheringstatechange = () => {
      logger.debug('[WebRTC Service] ICE gathering state changed:', this.peerConnection?.iceGatheringState);
    };

    this.peerConnection.oniceconnectionstatechange = () => {
      const state = this.peerConnection?.iceConnectionState;
      logger.debug('[WebRTC Service] ICE connection state changed:', state);

      // Clear any pending disconnect timer
      if (this.disconnectTimer) {
        clearTimeout(this.disconnectTimer);
        this.disconnectTimer = null;
      }

      if (state === 'disconnected') {
        // Start timer for ICE restart if disconnection persists
        this.disconnectTimer = setTimeout(() => {
          if (this.peerConnection?.iceConnectionState === 'disconnected' && !this.iceRestartInProgress) {
            logger.debug('[WebRTC Service] Prolonged disconnection detected, requesting ICE restart');
            this.handlers.onIceRestart?.();
          }
        }, WebRTCService.DISCONNECT_TIMEOUT_MS);
      } else if (state === 'failed') {
        // Immediately request ICE restart on failure
        if (!this.iceRestartInProgress) {
          logger.debug('[WebRTC Service] Connection failed, requesting ICE restart');
          this.handlers.onIceRestart?.();
        }
      } else if (state === 'connected' || state === 'completed') {
        this.iceRestartInProgress = false;
      }
    };
  }

  setHandlers(handlers: WebRTCEventHandlers): void {
    logger.debug('[WebRTC Service] setHandlers called, onIceCandidate handler:', handlers.onIceCandidate ? 'SET' : 'NOT SET');
    this.handlers = handlers;
  }

  async getUserMedia(video: boolean = true, audio: boolean = true): Promise<MediaStream> {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: video ? {
        width: { ideal: 640 },
        height: { ideal: 480 },
        frameRate: { ideal: 30 },
      } : false,
      audio: audio ? {
        echoCancellation: true,
        noiseSuppression: true,
      } : false,
    });

    this.attachLocalStream(stream);
    return stream;
  }

  /**
   * Hot-swap the outgoing video track. Used by the background-blur
   * pipeline: we replace the camera track with a synthetic canvas track
   * (or back). Same sender, same SSRC — no SDP renegotiation, peer just
   * sees a content change from the next encoded frame onward.
   *
   * Returns true if a sender existed and was updated; false if there's
   * no video sender yet (caller should fall back to attachLocalStream).
   */
  async replaceVideoTrack(newTrack: MediaStreamTrack | null): Promise<boolean> {
    if (!this.peerConnection) return false;
    const sender = this.peerConnection.getSenders().find((s) => s.track?.kind === 'video');
    if (!sender) return false;
    try {
      await sender.replaceTrack(newTrack);
      // Keep localStream in sync so UI bound to it sees the new track too.
      if (this.localStream && newTrack) {
        const oldTracks = this.localStream.getVideoTracks();
        oldTracks.forEach((t) => {
          // Don't stop the camera here — caller owns its lifecycle.
          // Only remove from the stream so consumers see the new track.
          try { this.localStream!.removeTrack(t); } catch { /* ignore */ }
        });
        try { this.localStream.addTrack(newTrack); } catch { /* ignore */ }
      }
      return true;
    } catch (err) {
      logger.warn('[WebRTC] replaceVideoTrack failed:', err);
      return false;
    }
  }

  /**
   * Wire an externally-acquired MediaStream into the peer connection. Used by
   * the pre-flight lobby: the lobby owns getUserMedia() (so the user grants
   * permission + previews + picks devices BEFORE entering the call), then
   * hands the resulting stream to us when they hit JOIN.
   *
   * Idempotent for the same stream id — re-attaching the same tracks would
   * raise InvalidAccessError on the second addTrack call, so we skip tracks
   * that already have a sender.
   */
  attachLocalStream(stream: MediaStream): void {
    if (!this.peerConnection) {
      logger.warn('[WebRTC] attachLocalStream called before initialize()');
      return;
    }
    this.localStream = stream;
    const existingTrackIds = new Set(
      this.peerConnection.getSenders()
        .map(s => s.track?.id)
        .filter((id): id is string => !!id),
    );
    stream.getTracks().forEach(track => {
      if (existingTrackIds.has(track.id)) return;
      try {
        this.peerConnection!.addTrack(track, stream);
      } catch (err) {
        logger.warn('[WebRTC] addTrack failed for', track.kind, err);
      }
    });
  }

  // Capture screen WITHOUT adding to peer connection (for permission flow)
  async captureScreen(quality: ScreenShareQuality = 'high'): Promise<{ stream: MediaStream; streamId: string; hasAudio: boolean }> {
    try {
      const preset = QualityPresets[quality];

      // Screen share audio should NOT have voice processing
      // Use quality preset for resolution and frame rate
      const constraints: DisplayMediaStreamOptions = {
        video: {
          frameRate: { ideal: preset.video.frameRate, max: 60 },
          width: { ideal: preset.video.width, max: 3840 },
          height: { ideal: preset.video.height, max: 2160 },
        } as MediaTrackConstraints,
        audio: true, // Simple audio request - let browser handle details
      };

      const stream = await navigator.mediaDevices.getDisplayMedia(constraints);

      // Mark video tracks as screen share using contentHint (W3C standard)
      // This allows the receiving peer to identify screen share tracks reliably
      const videoTracks = stream.getVideoTracks();
      for (const track of videoTracks) {
        if ('contentHint' in track) {
          // 'motion' tells the encoder to prioritize a steady frame rate over
          // per-frame sharpness — correct for film/dizi/oyun (moving content).
          // The old 'detail' did the opposite: it held resolution and starved
          // the frame rate under load, which is what made playback kesik kesik.
          // NOTE: contentHint is a LOCAL encoder hint and is NOT signaled to
          // the remote peer, so the receiver's screen-vs-camera routing relies
          // on the SignalR stream-id notification, not on this value.
          track.contentHint = 'motion';
        }
      }

      // Surface whether the browser actually captured audio. Safari is the usual
      // offender: getDisplayMedia({audio:true}) silently returns 0 audio tracks
      // when the user picks a window or full-screen share (Safari only captures
      // audio for *tab* shares, and only if "Share audio" was checked). Without
      // this signal, the caller has no way to tell the user why their friend
      // can't hear them — they just see a black-hole bug.
      const audioTracks = stream.getAudioTracks();
      const hasAudio = audioTracks.length > 0;
      logger.debug(
        `[ScreenShare] Captured ${videoTracks.length} video track(s), ` +
        `${audioTracks.length} audio track(s). ` +
        (hasAudio ? '✓ audio will reach peer.' : '⚠ no audio — peer will see video only.')
      );

      // Try to disable audio processing for cleaner sound (optional, may fail on some browsers)
      for (const track of audioTracks) {
        try {
          await track.applyConstraints({
            echoCancellation: false,
            noiseSuppression: false,
            autoGainControl: false,
          });
        } catch {
          // Ignore - some browsers don't support these constraints for display audio
        }
      }

      return { stream, streamId: stream.id, hasAudio };
    } catch (err) {
      throw err;
    }
  }

  /**
   * Motion-optimized video encoding parameters for a quality preset.
   * Mutates `params` in place. Shared by addScreenShareTracks (initial add)
   * and updateScreenShareQuality (live switch) so the two paths can never
   * drift apart.
   *
   * Why these choices (content = film/dizi/oyun → motion):
   *  - degradationPreference='maintain-framerate': under CPU/bandwidth
   *    pressure the encoder keeps the frame rate and sheds *resolution*
   *    instead. The old setup inherited 'maintain-resolution' (from
   *    contentHint='detail') and did the reverse — holding resolution while
   *    dropping frames. That is the root cause of the choppy playback.
   *  - We deliberately do NOT pin scaleResolutionDownBy: maintain-framerate
   *    can only do its job if the encoder is allowed to scale resolution
   *    down. The old `scaleResolutionDownBy = 1.0` forbade exactly that.
   *  - maxFramerate gives the encoder an explicit target instead of guessing.
   */
  private applyVideoEncoding(params: RTCRtpSendParameters, preset: QualityPreset): void {
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0];

    if (preset.video.bitrate > 0) {
      enc.maxBitrate = preset.video.bitrate;
    } else {
      // 'auto' preset — no ceiling, let adaptive bitrate climb freely.
      delete enc.maxBitrate;
    }
    enc.maxFramerate = preset.video.frameRate;
    // Allow the encoder to drop resolution to protect the frame rate.
    delete enc.scaleResolutionDownBy;
    if ('networkPriority' in enc) {
      (enc as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority = 'high';
    }

    // Whole-sender preference (not per-encoding): smoothness over sharpness.
    params.degradationPreference = 'maintain-framerate';
  }

  // Add screen share tracks to peer connection (after permission granted)
  async addScreenShareTracks(stream: MediaStream, quality: ScreenShareQuality = 'high'): Promise<void> {
    try {
      this.screenStream = stream;
      this.screenStreamId = stream.id;
      const preset = QualityPresets[quality];

      // ADD screen share tracks as new transceivers (do NOT replace camera)
      if (this.peerConnection) {
        const tracks = this.screenStream.getTracks();

        for (const track of tracks) {
          try {
            const sender = this.peerConnection.addTrack(track, this.screenStream!);
            if (track.kind === 'video') this.screenVideoSender = sender;
            else if (track.kind === 'audio') this.screenAudioSender = sender;

            // Configure encoding based on quality preset
            if (sender) {
              const params = sender.getParameters();
              if (!params.encodings || params.encodings.length === 0) {
                params.encodings = [{}];
              }

              if (track.kind === 'video') {
                // Motion-optimized: maintain-framerate + maxFramerate, and
                // crucially NO scaleResolutionDownBy pin (see applyVideoEncoding).
                this.applyVideoEncoding(params, preset);
              } else if (track.kind === 'audio') {
                // Use audio bitrate from quality preset
                if (preset.audio.bitrate > 0) {
                  params.encodings[0].maxBitrate = preset.audio.bitrate;
                }
              }

              try {
                await sender.setParameters(params);
                logger.debug(`[WebRTC] Set ${track.kind} encoding (${quality}):`, params.encodings[0]);
              } catch (err) {
                logger.debug(`[WebRTC] Could not set ${track.kind} encoding params:`, err);
              }
            }
          } catch {
            // Error adding track - continue with others
          }
        }
      }

      const videoTrack = this.screenStream.getVideoTracks()[0];
      if (videoTrack) {
        videoTrack.onended = () => {
          this.stopScreenShare();
        };
      }
    } catch (err) {
      throw err;
    }
  }

  // Legacy method - captures AND adds tracks (for direct sharing without peer)
  async getDisplayMedia(quality: ScreenShareQuality = 'high'): Promise<{ stream: MediaStream; streamId: string; needsRenegotiation: boolean }> {
    const { stream, streamId } = await this.captureScreen(quality);
    await this.addScreenShareTracks(stream, quality);
    return { stream, streamId, needsRenegotiation: true };
  }

  /**
   * Change the encoder bitrate / framerate of the in-flight screen-share
   * WITHOUT tearing down the stream or renegotiating SDP — the "Zoom-style"
   * quality switch: the viewer keeps seeing video the whole time, just at the
   * new quality from the next encoded frame onward.
   *
   * Robustness contract (Phase 2): for a live screen share this NEVER asks the
   * caller to recapture. setParameters()/applyConstraints() are best-effort — if
   * a browser rejects them (Safari/Firefox quirks) we log and keep the stream
   * running untouched. We return false ONLY when there is genuinely no live
   * screen video sender (i.e. not sharing). Recapture via getDisplayMedia is
   * justified solely when the captured *surface* changes — never for a
   * bitrate/framerate tweak (that re-prompts for permission and freezes the peer).
   */
  async updateScreenShareQuality(quality: ScreenShareQuality): Promise<boolean> {
    if (!this.peerConnection || !this.screenStream) return false;

    const preset = QualityPresets[quality];

    // Use the sender we kept at add time; fall back to a lookup only if that
    // reference went stale (e.g. after a track replace). Matching by exact
    // track.id alone — the old behavior — could miss and wrongly report
    // "nothing live", dropping the caller into a disruptive recapture.
    let videoSender = this.screenVideoSender;
    if (!videoSender || !videoSender.track || videoSender.track.readyState === 'ended') {
      const vt = this.screenStream.getVideoTracks()[0];
      videoSender =
        this.peerConnection
          .getSenders()
          .find((s) => s.track && vt && (s.track.id === vt.id || s.track === vt)) ?? null;
    }
    if (!videoSender) return false; // genuinely no live screen video sender

    // Encoder ceiling + degradation strategy. Same helper as the initial add, so
    // a live switch and a fresh share end up byte-for-byte identical.
    const params = videoSender.getParameters();
    this.applyVideoEncoding(params, preset);
    try {
      await videoSender.setParameters(params);
      logger.debug(`[WebRTC] updateScreenShareQuality video → ${quality}`, params.encodings[0]);
    } catch (err) {
      // CRITICAL: a bitrate tweak failing must NOT cascade into
      // stop+getDisplayMedia+renegotiate — that re-prompts for screen permission
      // and freezes the viewer. Treat it as a best-effort no-op; the stream keeps
      // running, we just didn't move the cap.
      logger.warn('[WebRTC] setParameters(video) failed — keeping stream as-is (non-fatal):', err);
    }

    // Best-effort framerate cap on the capture side. Partial browser support; a
    // failure here is fine — the encoder cap above does the heavy lifting.
    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (videoTrack) {
      try {
        await videoTrack.applyConstraints({ frameRate: { ideal: preset.video.frameRate, max: 60 } });
      } catch (err) {
        logger.debug('[WebRTC] applyConstraints(frameRate) not supported here:', err);
      }
    }

    // Match the audio encoder cap if there's a screen-share audio track.
    const audioSender = this.screenAudioSender;
    if (audioSender && audioSender.track && preset.audio.bitrate > 0) {
      const audioParams = audioSender.getParameters();
      if (!audioParams.encodings || audioParams.encodings.length === 0) {
        audioParams.encodings = [{}];
      }
      audioParams.encodings[0].maxBitrate = preset.audio.bitrate;
      try {
        await audioSender.setParameters(audioParams);
      } catch (err) {
        logger.debug('[WebRTC] setParameters(audio) failed (non-fatal):', err);
      }
    }

    // We had a live sender → the quality change is "applied" (best-effort).
    // Returning true keeps the caller on the non-disruptive path no matter what.
    return true;
  }

  async stopScreenShare(): Promise<boolean> {
    try {
      if (this.screenStream) {
        const screenTracks = this.screenStream.getTracks();

        // Remove tracks from peer connection if it exists
        if (this.peerConnection) {
          const senders = this.peerConnection.getSenders();
          for (const sender of senders) {
            if (sender.track && screenTracks.includes(sender.track)) {
              try {
                this.peerConnection.removeTrack(sender);
              } catch {
                // Ignore removal errors
              }
            }
          }
        }

        // Stop all tracks
        screenTracks.forEach(track => {
          try {
            track.stop();
          } catch {
            // Ignore stop errors
          }
        });

        this.screenStream = null;
        this.screenStreamId = null;
        this.screenVideoSender = null;
        this.screenAudioSender = null;
        return true; // needs renegotiation
      }
      return false;
    } catch {
      // Force cleanup even on error
      this.screenStream = null;
      this.screenStreamId = null;
      this.screenVideoSender = null;
      this.screenAudioSender = null;
      return false;
    }
  }

  getScreenStreamId(): string | null {
    return this.screenStreamId;
  }

  // Perfect-negotiation helpers for the renegotiation glare logic.
  isMakingOffer(): boolean {
    return this.makingOffer;
  }

  getSignalingState(): RTCSignalingState | null {
    return this.peerConnection?.signalingState ?? null;
  }

  async createOffer(iceRestart: boolean = false): Promise<string> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    // Log senders (what we're sending)
    const senders = this.peerConnection.getSenders();
    logger.debug('[WebRTC] Creating offer, senders:', senders.map(s => ({
      kind: s.track?.kind,
      enabled: s.track?.enabled,
      id: s.track?.id
    })), 'iceRestart:', iceRestart);

    if (iceRestart) {
      this.iceRestartInProgress = true;
    }

    // makingOffer guards the perfect-negotiation glare window: the receive side
    // treats an offer that arrives while we're makingOffer (or not stable) as a
    // collision.
    this.makingOffer = true;
    try {
      const offer = await this.peerConnection.createOffer({ iceRestart });
      logger.debug('[WebRTC] Offer created, setting local description (this should trigger ICE gathering)');
      await this.peerConnection.setLocalDescription(offer);
      logger.debug('[WebRTC] Local description set, ICE gathering state:', this.peerConnection.iceGatheringState);
      return JSON.stringify(offer);
    } finally {
      this.makingOffer = false;
    }
  }

  async createIceRestartOffer(): Promise<string> {
    logger.debug('[WebRTC] Creating ICE restart offer');
    return this.createOffer(true);
  }

  async createAnswer(): Promise<string> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    // Log senders (what we're sending)
    const senders = this.peerConnection.getSenders();
    logger.debug('[WebRTC] Creating answer, senders:', senders.map(s => ({
      kind: s.track?.kind,
      enabled: s.track?.enabled,
      id: s.track?.id
    })));

    const answer = await this.peerConnection.createAnswer();
    logger.debug('[WebRTC] Answer created, setting local description (this should trigger ICE gathering)');
    await this.peerConnection.setLocalDescription(answer);
    logger.debug('[WebRTC] Local description set, ICE gathering state:', this.peerConnection.iceGatheringState);
    return JSON.stringify(answer);
  }

  async setRemoteDescription(sdp: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    const description = JSON.parse(sdp) as RTCSessionDescriptionInit;
    await this.peerConnection.setRemoteDescription(new RTCSessionDescription(description));
    this.hasRemoteDescription = true;

    // Process any queued ICE candidates
    for (const candidate of this.pendingIceCandidates) {
      await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    }
    this.pendingIceCandidates = [];
  }

  async addIceCandidate(candidateStr: string): Promise<void> {
    if (!this.peerConnection) throw new Error('Peer connection not initialized');

    const candidate = JSON.parse(candidateStr) as RTCIceCandidateInit;

    // Queue candidate if remote description not set yet
    if (!this.hasRemoteDescription) {
      this.pendingIceCandidates.push(candidate);
      return;
    }

    await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
  }

  toggleAudio(enabled: boolean): void {
    this.localStream?.getAudioTracks().forEach(track => {
      track.enabled = enabled;
    });
  }

  /**
   * Camera on/off that physically releases the device on "off" so the
   * hardware indicator LED turns off (privacy). The previous implementation
   * just flipped track.enabled=false — which sends a black frame to the
   * peer but keeps capture running, so the LED stays lit. Modern privacy
   * UX wants the light to honestly reflect "is this app reading my camera."
   *
   * Flow:
   *   off → stop the live video track, sender.replaceTrack(null). Peer
   *         sees a 'mute' event on the track. localStream loses its video
   *         track (audio track preserved).
   *   on  → fresh getUserMedia({video: ...}), replaceTrack(newTrack) on
   *         the existing sender (no SDP change, no renegotiation). Peer
   *         sees an 'unmute' event and frames resume on the same SSRC.
   *
   * Trade-off: re-enabling now costs ~200-500 ms (getUserMedia round-trip
   * plus first encoded frame). Worth it for the LED honesty — the
   * alternative is your camera reading frames for hours while the UI
   * insists "camera off."
   *
   * Returns a Promise so callers that care about the latency can await it.
   * Fire-and-forget callers (current usage) just discard.
   */
  async toggleVideo(enabled: boolean): Promise<void> {
    if (!this.peerConnection || !this.localStream) return;

    const videoSender = this.peerConnection
      .getSenders()
      .find((s) => s.track?.kind === 'video');

    if (!enabled) {
      const videoTracks = this.localStream.getVideoTracks();
      // Stop FIRST so the LED extinguishes even if replaceTrack hangs on
      // some browser quirk. The order matters for the user-visible signal.
      videoTracks.forEach((t) => {
        try { t.stop(); } catch { /* ignore */ }
        try { this.localStream!.removeTrack(t); } catch { /* ignore */ }
      });
      if (videoSender) {
        try {
          await videoSender.replaceTrack(null);
        } catch (err) {
          logger.warn('[WebRTC] replaceTrack(null) failed:', err);
        }
      }
      return;
    }

    // Re-enabling — acquire a fresh video track. Audio is untouched.
    let newStream: MediaStream;
    try {
      newStream = await navigator.mediaDevices.getUserMedia({
        video: {
          width: { ideal: 640 },
          height: { ideal: 480 },
          frameRate: { ideal: 30 },
        },
      });
    } catch (err) {
      logger.warn('[WebRTC] re-acquire camera failed:', err);
      throw err;
    }

    const newVideoTrack = newStream.getVideoTracks()[0];
    if (!newVideoTrack) return;

    if (videoSender) {
      // Same sender, new track — no renegotiation. Peer's transceiver
      // sees a continuous video stream just with different content from
      // the next frame onward.
      try {
        await videoSender.replaceTrack(newVideoTrack);
      } catch (err) {
        logger.warn('[WebRTC] replaceTrack(new) failed, adding fresh:', err);
        this.peerConnection.addTrack(newVideoTrack, this.localStream);
      }
    } else {
      // No previous video sender (shouldn't happen post-PreflightLobby, but
      // belt-and-braces for edge cases like permission-denied initial join).
      this.peerConnection.addTrack(newVideoTrack, this.localStream);
    }
    this.localStream.addTrack(newVideoTrack);
  }

  getLocalStream(): MediaStream | null {
    return this.localStream;
  }

  getScreenStream(): MediaStream | null {
    return this.screenStream;
  }

  async getStats(): Promise<RTCStatsReport | null> {
    if (!this.peerConnection) return null;
    return this.peerConnection.getStats();
  }

  close(): void {
    if (this.disconnectTimer) {
      clearTimeout(this.disconnectTimer);
      this.disconnectTimer = null;
    }
    // Before the peer connection goes, so the channels close cleanly rather
    // than being torn out from under their handlers.
    dataChannelService.detach();
    this.localStream?.getTracks().forEach(track => track.stop());
    this.screenStream?.getTracks().forEach(track => track.stop());
    this.peerConnection?.close();
    this.localStream = null;
    this.screenStream = null;
    this.screenStreamId = null;
    this.screenVideoSender = null;
    this.screenAudioSender = null;
    this.peerConnection = null;
    this.hasRemoteDescription = false;
    this.pendingIceCandidates = [];
    this.iceRestartInProgress = false;
  }
}

export const webrtcService = new WebRTCService();
