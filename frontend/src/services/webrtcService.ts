import { logger } from './logger';
import { dataChannelService } from './dataChannelService';
import type {
  IceServerConfig,
  TransportPath,
  IceCandidateKind,
  OutboundScreenStats,
} from '../types';
import type { OperatingPoint } from '../hooks/operatingPoint';
import { applyOpusOptions, SDP_WARN_LENGTH } from './opusFmtp';

/**
 * Encoder ceilings for the camera, in bps.
 *
 * The camera had no ceiling at all, so Chrome's default applied — and on a
 * measured session that default let a 640x480 webcam settle at 1700 kbps while
 * the screen share it was competing with got 600 kbps and was encoded down to
 * 318x178. Both senders reported qualityLimitationReason 'bandwidth' for
 * essentially the whole connection, so this was a split of a fixed budget, not
 * a shortage the camera was innocent of.
 *
 * 640x480 at 30fps is a talking head in a corner; VP8 has no use for more than
 * IDLE here. WHILE_SHARING is the one that matters: the shared screen is the
 * thing both people are actually watching, so the thumbnail yields to it.
 */
const CAMERA_MAX_BITRATE_IDLE = 400_000;
const CAMERA_MAX_BITRATE_WHILE_SHARING = 64_000;

/**
 * How far the camera is scaled down while a screen share is running.
 *
 * 2 takes 640x480 to 320x240, which is more than the corner thumbnail is ever
 * displayed at. Without this the encoder keeps trying to hold 640x480 inside a
 * tight ceiling and spends the budget on macroblock noise; told to shrink, it
 * spends the same bits on a clean small picture.
 */
const CAMERA_SCALE_DOWN_WHILE_SHARING = 2;

/**
 * Camera frame rate while sharing.
 *
 * The cheaper trade than resolution. A corner thumbnail is a near-static
 * talking head, and temporal detail is the first thing nobody is looking at
 * once there is a film playing next to it — so buy the bits back from frame
 * rate rather than shrinking the picture further. 8 fps at 320x240 reads as a
 * live person; 30 fps at the same size costs three times as much to say it.
 *
 * Combined with the ceiling above this frees ~86 kbps against the old
 * 150 kbps/30 fps setting, which on a 2 Mbps uplink is ~4% of the whole link
 * handed back to the thing both people are actually watching.
 */
const CAMERA_MAX_FRAMERATE_WHILE_SHARING = 8;

/**
 * Microphone ceiling, in bps.
 *
 * The mic sender was never configured at all — attachLocalStream recorded the
 * video sender and dropped the audio one on the floor — so it ran on Chrome's
 * default and was neither bounded nor accounted for in any budget. 24 kbps is
 * comfortably transparent for mono speech in Opus (which is what the codec
 * picks for a voice track anyway); the point is that it is now a known line
 * item rather than an assumption.
 *
 * networkPriority 'high', not 'low': voice is the last thing that should break.
 * A call where the picture softens is still a call; a call where the other
 * person cuts out is not.
 */
const MIC_MAX_BITRATE = 24_000;

/**
 * Capture constraints for an operating point.
 *
 * Shared by the initial getDisplayMedia and every later re-apply so the two can
 * never drift — the drift was a real bug: captureScreen set width/height/fps
 * from the preset, and updateScreenShareQuality re-applied only frameRate, so a
 * track captured at 720p stayed 720p forever no matter what the ceiling later
 * became.
 *
 * `max` and not just `ideal`. The old code passed `max: 3840/2160/60` for every
 * preset, so on a 4K desktop the track arrived at 3840x2160 and Chrome's
 * quality scaler stepped 2160 -> 1440 -> 1080 -> 720: any pressure at all put
 * the stream two steps below 1080p, and every frame paid a 4K->1080 downscale
 * before it even reached the encoder. Capturing at the chosen size makes that
 * size the ceiling the scaler defends rather than a waypoint it passes through.
 */
function displayConstraintsFor(point: OperatingPoint): MediaTrackConstraints {
  return {
    width: { ideal: point.width, max: point.width },
    height: { ideal: point.height, max: point.height },
    frameRate: { ideal: point.fps, max: point.fps },
  };
}

/**
 * Read a persisted setting without ever throwing.
 *
 * `typeof localStorage !== 'undefined'` is not enough of a guard: the object
 * can exist while `getItem` does not (test environments and some embedded
 * webviews), and it can throw outright under privacy settings that block
 * storage. That matters more than it looks — the only caller runs inside
 * addScreenShareTracks' per-track try block, which also guards the
 * setParameters call, so a throw here silently skips the encoder's bitrate
 * ceiling and leaves the share running uncapped.
 */
function readSetting(key: string): string | null {
  try {
    if (typeof localStorage === 'undefined') return null;
    if (typeof localStorage.getItem !== 'function') return null;
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/**
 * Opus settings applied to our local description.
 *
 * DTX is the one that pays for itself here: this is a co-watching app, so both
 * people are silent for most of a session, and without it the mic transmits a
 * continuous ~24 kbps of encoded room tone for the privilege of saying nothing.
 * In-band FEC costs a little and buys real resilience on a lossy link.
 *
 * Stereo is deliberately NOT forced on: the screen-share audio track wants it
 * and the mic does not, and this applies to the whole session description. The
 * per-sender maxBitrate set in addScreenShareTracks is what actually
 * differentiates the two.
 */
const OPUS_OPTIONS = { dtx: true, fec: true } as const;

/**
 * The subset of `outbound-rtp` this app reads. Module-scope rather than local
 * to one method because two of them now share it, and a second hand-written
 * copy is how the two drift apart.
 */
type OutboundReport = RTCStats & {
  kind?: string;
  mediaSourceId?: string;
  frameWidth?: number;
  frameHeight?: number;
  framesPerSecond?: number;
  targetBitrate?: number;
  qualityLimitationReason?: string;
  encoderImplementation?: string;
  totalEncodeTime?: number;
  framesEncoded?: number;
};

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
  // Same treatment for the camera, and for a sharper reason: a camera toggled
  // off keeps its sender with track === null, so nothing about the *tracks* can
  // point back at it. See getCameraVideoSender.
  private cameraVideoSender: RTCRtpSender | null = null;
  // The mic. Recorded for the same reason as the camera — it needs a ceiling,
  // and "the first audio sender" stops being the mic the moment a screen share
  // with audio is added.
  private micAudioSender: RTCRtpSender | null = null;
  // The operating point currently applied to the screen share. Held so the
  // 'configurationchange' handler can re-assert geometry after a surface swap
  // without the caller having to remember what it asked for.
  private currentPoint: OperatingPoint | null = null;
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
      // One ICE transport, one DTLS handshake, and — the reason it is here —
      // ONE congestion controller shared by all four senders. Every bitrate
      // decision in this file assumes camera, mic, screen video and screen
      // audio are drawing on a single budget; 'max-bundle' is what makes that
      // assumption true rather than merely Chrome's default.
      bundlePolicy: 'max-bundle',
      rtcpMuxPolicy: 'require',
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
    const sender = this.getCameraVideoSender();
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
        const sender = this.peerConnection!.addTrack(track, stream);
        if (track.kind === 'video') this.cameraVideoSender = sender;
        else if (track.kind === 'audio') this.micAudioSender = sender;
      } catch (err) {
        logger.warn('[WebRTC] addTrack failed for', track.kind, err);
      }
    });

    // Cap both the moment they have senders. Fire-and-forget: this method is
    // sync for its callers and a failed cap is never worth blocking a join.
    void this.applyCameraEncoding(!!this.screenStream);
    void this.applyMicEncoding();
  }

  /**
   * Hold the microphone to a known, bounded share of the uplink.
   *
   * Not a bandwidth emergency on its own — Opus voice is cheap — but it was the
   * one sender in the connection with no ceiling and no line in any budget, and
   * an unmeasured stream is the one that surprises you. High priority so that
   * when the estimate drops it is the picture that gives ground, not the voice.
   */
  private async applyMicEncoding(): Promise<void> {
    const sender = this.micAudioSender;
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: RTCPriorityType;
    };
    enc.maxBitrate = MIC_MAX_BITRATE;
    enc.networkPriority = 'high';

    if (await this.setParametersSafely(sender, params, 'mic')) {
      logger.debug(`[WebRTC] Mic capped at ${MIC_MAX_BITRATE} bps`);
    }
  }

  // Capture screen WITHOUT adding to peer connection (for permission flow)
  async captureScreen(point: OperatingPoint): Promise<{ stream: MediaStream; streamId: string; hasAudio: boolean }> {
    try {
      // Screen share audio should NOT have voice processing.
      const constraints: DisplayMediaStreamOptions = {
        video: displayConstraintsFor(point),
        audio: true, // Simple audio request - let browser handle details
        // Never offer this app's own tab as a share target: picking it is a
        // hall of mirrors and is never what anyone meant.
        selfBrowserSurface: 'exclude',
        // Let the user switch which window/tab they are sharing without a fresh
        // permission prompt. Handled below via 'configurationchange'.
        surfaceSwitching: 'include',
        // NOTE: displaySurface is deliberately NOT set. Biasing toward
        // 'browser' would give better quality for tab-captured video, but DRM
        // content (Netflix, Disney+) renders black on the protected path under
        // tab capture — which would break the app's primary use case.
      } as DisplayMediaStreamOptions;

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

        // surfaceSwitching means the user can change what they are sharing
        // mid-stream, and the new surface arrives with the browser's own
        // settings — our pinned geometry and the contentHint are both gone.
        // Re-assert them rather than silently reverting to an unpinned 4K grab.
        track.addEventListener('configurationchange', () => {
          const current = this.currentPoint;
          if (!current) return;
          void track.applyConstraints(displayConstraintsFor(current)).catch(() => {
            /* best effort — the encoder ceiling still holds the line */
          });
          if ('contentHint' in track) track.contentHint = 'motion';
        });
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
   * The sender carrying the camera.
   *
   * Held by reference from the addTrack that created it, because neither of the
   * cheaper answers survives a screen share. "First video sender" is ordering
   * luck — once the share is up there are two, and which comes first is an
   * accident of when addTrack ran. "First video sender with a live track" is
   * worse: toggleVideo(false) leaves the camera's sender in place with
   * track === null, so that scan skips the camera and returns the *screen*, and
   * the next replaceTrack silently paints the webcam over the shared screen.
   *
   * The track-id lookup against localStream stays as the fallback for a sender
   * we never recorded — it is still correct whenever the camera has a track,
   * including after background blur swaps a canvas track in through localStream.
   */
  private getCameraVideoSender(): RTCRtpSender | null {
    if (!this.peerConnection) return null;
    const senders = this.peerConnection.getSenders();
    if (this.cameraVideoSender && senders.includes(this.cameraVideoSender)) {
      return this.cameraVideoSender;
    }

    if (!this.localStream) return null;
    const cameraTrackIds = new Set(this.localStream.getVideoTracks().map((t) => t.id));
    this.cameraVideoSender =
      senders.find((s) => s.track?.kind === 'video' && cameraTrackIds.has(s.track.id)) ?? null;
    return this.cameraVideoSender;
  }

  /**
   * setParameters, with the bitrate cap protected from the priority hint.
   *
   * networkPriority is the less portable of the two knobs, and a browser that
   * rejects it would otherwise take the maxBitrate ceiling down with it — the
   * whole call throws, and we'd silently keep the uncapped encoder that caused
   * the problem. So: try both, and on failure retry with the ceiling alone.
   */
  private async setParametersSafely(
    sender: RTCRtpSender,
    params: RTCRtpSendParameters,
    label: string,
  ): Promise<boolean> {
    try {
      await sender.setParameters(params);
      return true;
    } catch (err) {
      logger.debug(`[WebRTC] setParameters(${label}) rejected, retrying without priority:`, err);
    }

    const enc = params.encodings?.[0] as
      | (RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType })
      | undefined;
    if (enc) delete enc.networkPriority;

    try {
      await sender.setParameters(params);
      return true;
    } catch (err) {
      logger.warn(`[WebRTC] setParameters(${label}) failed — encoder left as-is:`, err);
      return false;
    }
  }

  /**
   * Hold the camera to its share of the uplink.
   *
   * Two mechanisms, because they fail differently: maxBitrate is a hard ceiling
   * the allocator cannot exceed, and networkPriority biases which stream sheds
   * first when the estimate drops. The cap alone would still let Chrome split a
   * *shrinking* budget evenly between camera and screen; the priority makes the
   * camera the one that gives ground.
   *
   * Assigned unconditionally rather than behind `'networkPriority' in enc` —
   * that guard reads as defensive but is a no-op switch: browsers are not
   * obliged to pre-populate the key in getParameters(), and where they don't,
   * the guard silently skips the setting it exists to protect.
   */
  private async applyCameraEncoding(isSharing: boolean): Promise<void> {
    const sender = this.getCameraVideoSender();
    if (!sender) return;

    const params = sender.getParameters();
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0] as RTCRtpEncodingParameters & {
      networkPriority?: RTCPriorityType;
    };
    enc.maxBitrate = isSharing ? CAMERA_MAX_BITRATE_WHILE_SHARING : CAMERA_MAX_BITRATE_IDLE;
    enc.networkPriority = isSharing ? 'low' : 'medium';
    if (isSharing) {
      enc.scaleResolutionDownBy = CAMERA_SCALE_DOWN_WHILE_SHARING;
      // Trade temporal detail, not more spatial detail. See the constant.
      enc.maxFramerate = CAMERA_MAX_FRAMERATE_WHILE_SHARING;
    } else {
      delete enc.scaleResolutionDownBy;
      delete enc.maxFramerate;
    }

    if (await this.setParametersSafely(sender, params, 'camera')) {
      logger.debug(`[WebRTC] Camera capped at ${enc.maxBitrate} bps (sharing: ${isSharing})`);
    }
  }

  /**
   * Ask for VP9 on the screen share.
   *
   * The measured session encoded with `libvpx` — VP8 — and the picture was the
   * complaint. VP9 carries roughly the same quality in 30-50% fewer bits, and
   * on a link that is bandwidth-limited every hour of the day, fewer bits per
   * frame converts directly into resolution: the encoder stops having to choose
   * 318x178 to stay inside its ceiling. This is the only lever here that
   * improves the picture without taking bandwidth from something else.
   *
   * Promote-only, rather than sorting the whole list: RTX, RED and FEC entries
   * keep their original relative order, and a browser without VP9 is left
   * exactly as it was. setCodecPreferences also only reorders *our* offer — the
   * answerer still picks from the intersection — so a peer that cannot do VP9
   * negotiates VP8 as before rather than failing.
   *
   * The trade is CPU: VP9 encode costs more than VP8. The measured session had
   * `qualityLimitationDurations.cpu` at 0, so there was headroom, but that was
   * headroom at 318x178. If this flips the limitation from 'bandwidth' to
   * 'cpu', this is the change to revert.
   */
  private preferVp9(sender: RTCRtpSender): void {
    if (!this.peerConnection) return;

    const transceiver = this.peerConnection
      .getTransceivers()
      .find((t) => t.sender === sender);
    if (!transceiver?.setCodecPreferences) return;

    // typeof, not a bare reference: this runs inside addScreenShareTracks'
    // per-track try block, and a ReferenceError here would be swallowed by it
    // *after* skipping the setParameters call that applies the bitrate ceiling.
    if (typeof RTCRtpSender === 'undefined') return;
    const codecs = RTCRtpSender.getCapabilities?.('video')?.codecs;
    if (!codecs?.length) return;

    /**
     * AV1 is worth roughly 30% over VP9 and is the largest codec lever there
     * is — but only where the encoder is in hardware. Apple Silicon has AV1
     * DECODE only, so on this machine choosing AV1 means software libaom in
     * realtime at 1080p, which trades a bandwidth limit for a CPU limit and
     * makes the picture worse, not better. Opt-in, so it can be measured before
     * it is trusted; useSenderHealth reports 'cpu-bound' if it goes wrong.
     */
    const wantsAv1 = readSetting('wt:codec') === 'av1';

    const rank = (mime: string): number => {
      if (wantsAv1 && /\/av01?$/i.test(mime)) return 0;
      if (/\/vp9$/i.test(mime)) return 1;
      return 2;
    };

    /**
     * VP9 profile 0 ahead of the rest.
     *
     * The old filter promoted every VP9 entry while preserving the browser's
     * own relative order, so a profile-2 entry (10-bit 4:2:0) listed first was
     * what actually got offered — more CPU and more bits to carry content that
     * is 8-bit anyway. A missing sdpFmtpLine is treated as profile 0, which is
     * what browsers that omit it mean.
     */
    const isProfile0 = (c: RTCRtpCodec): boolean => {
      const fmtp = c.sdpFmtpLine;
      if (!fmtp) return true;
      const match = /profile-id=(\d+)/.exec(fmtp);
      return !match || match[1] === '0';
    };

    // Stable sort by rank, then profile — everything that is neither AV1 nor
    // VP9 (RTX, RED, FEC, H.264) keeps its original relative order, so a
    // browser without the preferred codecs is left exactly as it was.
    const reordered = codecs
      .map((codec, index) => ({ codec, index }))
      .sort((a, b) => {
        const byRank = rank(a.codec.mimeType) - rank(b.codec.mimeType);
        if (byRank !== 0) return byRank;
        const byProfile = Number(isProfile0(b.codec)) - Number(isProfile0(a.codec));
        if (byProfile !== 0) return byProfile;
        return a.index - b.index;
      })
      .map((entry) => entry.codec);

    // Nothing worth promoting — leave the order alone rather than reshuffling
    // into some guess at a preference.
    if (reordered.every((c, i) => c === codecs[i])) return;

    try {
      transceiver.setCodecPreferences(reordered);
      logger.debug('[WebRTC] Screen share codec order:', reordered[0]?.mimeType);
    } catch (err) {
      // Not fatal in any way: we simply negotiate whatever the browser would
      // have negotiated on its own.
      logger.debug('[WebRTC] setCodecPreferences rejected:', err);
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
  private applyVideoEncoding(params: RTCRtpSendParameters, point: OperatingPoint): void {
    if (!params.encodings || params.encodings.length === 0) {
      params.encodings = [{}];
    }
    const enc = params.encodings[0];

    // Always finite. The old 'auto' path did `delete enc.maxBitrate`, leaving
    // the encoder unbounded — which on a link slower than its ambition means
    // overshoot, a standing queue in the pacer, and a picture that is soft and
    // laggy at the same time. chooseOperatingPoint clamps 'auto' to
    // AUTO_MAX_BITRATE instead, so there is nothing left to special-case here.
    enc.maxBitrate = point.videoBps;
    enc.maxFramerate = point.fps;
    // Allow the encoder to drop resolution to protect the frame rate.
    delete enc.scaleResolutionDownBy;
    // Unconditional: the old `'networkPriority' in enc` guard meant this only
    // applied on browsers that happened to echo the key back from
    // getParameters(), so the priority boost the screen share is supposed to
    // have could silently never be set. setParametersSafely covers the risk.
    (enc as RTCRtpEncodingParameters & { networkPriority?: RTCPriorityType }).networkPriority =
      'high';

    // Whole-sender preference (not per-encoding): smoothness over sharpness.
    params.degradationPreference = 'maintain-framerate';
  }

  // Add screen share tracks to peer connection (after permission granted)
  async addScreenShareTracks(stream: MediaStream, point: OperatingPoint): Promise<void> {
    try {
      this.screenStream = stream;
      this.screenStreamId = stream.id;
      this.currentPoint = point;

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
                this.applyVideoEncoding(params, point);
                // Before the renegotiation this addTrack triggers, so the codec
                // order lands in the offer rather than needing a second one.
                this.preferVp9(sender);
              } else if (track.kind === 'audio') {
                if (point.audioBps > 0) {
                  params.encodings[0].maxBitrate = point.audioBps;
                }
              }

              if (await this.setParametersSafely(sender, params, `screen ${track.kind}`)) {
                logger.debug(`[WebRTC] Set ${track.kind} encoding:`, params.encodings[0]);
              }
            }
          } catch {
            // Error adding track - continue with others
          }
        }
      }

      // The screen is now the thing worth spending uplink on — stand the camera
      // down before the encoder has a chance to settle at its old ceiling.
      await this.applyCameraEncoding(true);

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
  async getDisplayMedia(point: OperatingPoint): Promise<{ stream: MediaStream; streamId: string; needsRenegotiation: boolean }> {
    const { stream, streamId } = await this.captureScreen(point);
    await this.addScreenShareTracks(stream, point);
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
  async updateScreenShareQuality(point: OperatingPoint): Promise<boolean> {
    if (!this.peerConnection || !this.screenStream) return false;

    const previous = this.currentPoint;
    this.currentPoint = point;

    // Shared with getOutboundScreenStats: one resolver, so a stale reference
    // cannot be handled in one place and ignored in the other. Wrongly
    // reporting "nothing live" here would drop the caller into a disruptive
    // recapture.
    const videoSender = this.resolveScreenVideoSender();
    if (!videoSender) return false; // genuinely no live screen video sender

    // Encoder ceiling + degradation strategy. Same helper as the initial add, so
    // a live switch and a fresh share end up byte-for-byte identical.
    const params = videoSender.getParameters();
    this.applyVideoEncoding(params, point);
    // CRITICAL: a bitrate tweak failing must NOT cascade into
    // stop+getDisplayMedia+renegotiate — that re-prompts for screen permission
    // and freezes the viewer. setParametersSafely swallows the failure; the
    // stream keeps running, we just didn't move the cap.
    if (await this.setParametersSafely(videoSender, params, 'screen video')) {
      logger.debug('[WebRTC] updateScreenShareQuality video →', params.encodings[0]);
    }

    // Geometry AND frame rate, in ONE call.
    //
    // This used to re-apply frameRate alone, which is why a share that had once
    // been clamped to 720p stayed 720p for the rest of the session no matter
    // how far the ceiling was later raised: the capture track was never told it
    // could grow again. One call and not two because applyConstraints replaces
    // the entire constraint set — a frameRate-only call after a geometry call
    // silently clears the geometry.
    //
    // Only when the geometry actually moved. Re-running applyConstraints on an
    // unchanged size can make the capturer renegotiate its pipeline for nothing,
    // and the bitrate above changes far more often than the resolution does.
    const geometryChanged =
      !previous ||
      previous.width !== point.width ||
      previous.height !== point.height ||
      previous.fps !== point.fps;

    const videoTrack = this.screenStream.getVideoTracks()[0];
    if (videoTrack && geometryChanged) {
      try {
        await videoTrack.applyConstraints(displayConstraintsFor(point));
      } catch (err) {
        logger.debug('[WebRTC] applyConstraints(geometry) not supported here:', err);
      }
    }

    // Match the audio encoder cap if there's a screen-share audio track.
    const audioSender = this.screenAudioSender;
    if (audioSender && audioSender.track && point.audioBps > 0) {
      const audioParams = audioSender.getParameters();
      if (!audioParams.encodings || audioParams.encodings.length === 0) {
        audioParams.encodings = [{}];
      }
      audioParams.encodings[0].maxBitrate = point.audioBps;
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

        // Nothing left to yield to — give the camera its full ceiling back.
        await this.applyCameraEncoding(false);
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
      this.tuneOpus(offer);
      logger.debug('[WebRTC] Offer created, setting local description (this should trigger ICE gathering)');
      await this.peerConnection.setLocalDescription(offer);
      logger.debug('[WebRTC] Local description set, ICE gathering state:', this.peerConnection.iceGatheringState);
      return JSON.stringify(offer);
    } finally {
      this.makingOffer = false;
    }
  }

  /**
   * Rewrite the Opus fmtp line on a local description, in place.
   *
   * Mutates rather than returning, because the caller must hand the SAME object
   * to setLocalDescription — a rebuilt RTCSessionDescriptionInit loses nothing
   * here, but keeping one object makes it impossible to accidentally set the
   * untuned original.
   *
   * Best-effort by construction: applyOpusOptions returns the input unchanged
   * on anything it does not recognise, so the worst case is that we negotiate
   * exactly what the browser would have negotiated on its own.
   */
  private tuneOpus(description: RTCSessionDescriptionInit): void {
    if (!description.sdp) return;
    const tuned = applyOpusOptions(description.sdp, OPUS_OPTIONS);

    // The Worker silently DROPS a signalling frame whose SDP exceeds
    // MAX_SDP_LENGTH (30,000 chars) — no error frame, no close code, the offer
    // simply never arrives and the call hangs with no diagnosis. This edit only
    // adds a few dozen characters, but it is the one change here that grows the
    // SDP at all, so it is the one that has to watch the ceiling.
    if (tuned.length > SDP_WARN_LENGTH) {
      logger.warn(
        `[WebRTC] SDP is ${tuned.length} chars, approaching the worker's 30000 limit ` +
          '— frames over the limit are dropped silently.',
      );
    }
    description.sdp = tuned;
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
    this.tuneOpus(answer);
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

    // Not "the first video sender": with a share up that is a coin flip, and
    // once this method has run once with enabled=false the camera's own sender
    // has no track to be found by. See getCameraVideoSender.
    const videoSender = this.getCameraVideoSender();

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
        this.cameraVideoSender = this.peerConnection.addTrack(newVideoTrack, this.localStream);
      }
    } else {
      // No previous video sender (shouldn't happen post-PreflightLobby, but
      // belt-and-braces for edge cases like permission-denied initial join).
      this.cameraVideoSender = this.peerConnection.addTrack(newVideoTrack, this.localStream);
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

  /**
   * Which path the media is actually taking: direct, reflexive, or relayed.
   *
   * Reads `transport.selectedCandidatePairId` first — that is the authoritative
   * answer where it exists — and falls back to scanning for the nominated
   * succeeded pair on browsers that do not publish a transport report.
   *
   * Returns null rather than guessing when no pair has been selected yet. Same
   * discipline as readOutgoingBitrate in useUplinkEstimate: a fabricated answer
   * here would be worse than none, because the whole point of this method is to
   * be trusted when it says "you are relayed".
   */
  async getTransportPath(): Promise<TransportPath | null> {
    const stats = await this.getStats();
    if (!stats) return null;

    type PairReport = RTCStats & {
      selected?: boolean;
      nominated?: boolean;
      state?: string;
      localCandidateId?: string;
      remoteCandidateId?: string;
      currentRoundTripTime?: number;
    };
    type CandidateReport = RTCStats & {
      candidateType?: string;
      protocol?: string;
      relayProtocol?: string;
    };

    let selectedId: string | undefined;
    let fallbackPair: PairReport | undefined;

    stats.forEach((report) => {
      if (report.type === 'transport') {
        const t = report as RTCStats & { selectedCandidatePairId?: string };
        if (t.selectedCandidatePairId) selectedId = t.selectedCandidatePairId;
      } else if (report.type === 'candidate-pair') {
        const pair = report as PairReport;
        if (pair.state !== 'succeeded') return;
        // Prefer a pair the browser marks selected/nominated, but keep any
        // succeeded pair rather than returning nothing.
        if (!fallbackPair || pair.nominated || pair.selected) fallbackPair = pair;
      }
    });

    const pair = (selectedId ? (stats.get(selectedId) as PairReport | undefined) : undefined) ?? fallbackPair;
    if (!pair) return null;

    const local = pair.localCandidateId
      ? (stats.get(pair.localCandidateId) as CandidateReport | undefined)
      : undefined;
    const remote = pair.remoteCandidateId
      ? (stats.get(pair.remoteCandidateId) as CandidateReport | undefined)
      : undefined;
    if (!local || !remote) return null;

    const kind = (v: string | undefined): IceCandidateKind =>
      v === 'relay' || v === 'srflx' || v === 'prflx' ? v : 'host';
    const localKind = kind(local.candidateType);
    const remoteKind = kind(remote.candidateType);

    return {
      local: localKind,
      remote: remoteKind,
      protocol: local.protocol ?? 'udp',
      relayProtocol: local.relayProtocol,
      isRelayed: localKind === 'relay' || remoteKind === 'relay',
      rttMs:
        typeof pair.currentRoundTripTime === 'number'
          ? Math.round(pair.currentRoundTripTime * 1000)
          : null,
    };
  }

  /**
   * Locate the live screen-share video sender.
   *
   * `screenVideoSender` is recorded once, at addTrack time. A track replace or
   * a connection rebuild can leave it stale — pointing at a sender whose stats
   * report comes back empty. updateScreenShareQuality already fell back to a
   * lookup for exactly that reason; getOutboundScreenStats did not, and just
   * reported "no encoder" instead. That asymmetry is why the diagnostics line
   * went blank on a share that was demonstrably sending: null there also
   * starves useSenderHealth, which is the control loop's ONLY input, so the
   * whole thing quietly stopped adapting.
   */
  private resolveScreenVideoSender(): RTCRtpSender | null {
    const recorded = this.screenVideoSender;
    if (recorded?.track && recorded.track.readyState !== 'ended') return recorded;
    if (!this.peerConnection || !this.screenStream) return recorded ?? null;

    const vt = this.screenStream.getVideoTracks()[0];
    if (!vt) return recorded ?? null;

    const found =
      this.peerConnection
        .getSenders()
        .find((s) => s.track && (s.track.id === vt.id || s.track === vt)) ?? null;
    // Re-record so the next poll skips the search.
    if (found) this.screenVideoSender = found;
    return found ?? recorded ?? null;
  }

  /**
   * Pick the screen share's outbound-rtp out of a stats report.
   *
   * With a share running there are TWO outbound video streams — the screen and
   * the camera thumbnail — so "the video one" is not a selector. Prefer the
   * exact link (media-source.trackIdentifier), because it is the only
   * non-heuristic way to tie an RTP stream back to the track feeding it, and
   * fall back to the larger picture only when the report omits that link.
   */
  private pickOutboundVideo(
    report: RTCStatsReport,
    track: MediaStreamTrack | null,
  ): OutboundReport | null {
    const candidates: OutboundReport[] = [];
    report.forEach((r) => {
      if (r.type === 'outbound-rtp' && (r as OutboundReport).kind === 'video') {
        candidates.push(r as OutboundReport);
      }
    });
    if (candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0];

    if (track) {
      for (const c of candidates) {
        if (!c.mediaSourceId) continue;
        const src = report.get(c.mediaSourceId) as { trackIdentifier?: string } | undefined;
        if (src?.trackIdentifier === track.id) return c;
      }
    }

    const area = (o: OutboundReport) => (o.frameWidth ?? 0) * (o.frameHeight ?? 0);
    return candidates.reduce((a, b) => (area(b) > area(a) ? b : a));
  }

  /**
   * What the screen-share encoder is actually producing.
   *
   * Asks the sender first — it knows its own SSRC — but falls through to the
   * connection-wide report when that comes back empty, which is what a stale
   * sender reference looks like from here.
   */
  async getOutboundScreenStats(): Promise<OutboundScreenStats | null> {
    const sender = this.resolveScreenVideoSender();
    const track = this.screenStream?.getVideoTracks()[0] ?? null;

    let found: OutboundReport | null = null;

    if (sender && typeof sender.getStats === 'function') {
      try {
        found = this.pickOutboundVideo(await sender.getStats(), track);
      } catch {
        found = null;
      }
    }

    if (!found && this.peerConnection) {
      try {
        found = this.pickOutboundVideo(await this.peerConnection.getStats(), track);
      } catch {
        found = null;
      }
    }

    if (!found) return null;

    const o: OutboundReport = found;
    const reason = o.qualityLimitationReason;
    return {
      frameWidth: o.frameWidth ?? null,
      frameHeight: o.frameHeight ?? null,
      framesPerSecond: o.framesPerSecond ?? null,
      targetBitrate: o.targetBitrate ?? null,
      qualityLimitationReason:
        reason === 'none' || reason === 'cpu' || reason === 'bandwidth' || reason === 'other'
          ? reason
          : null,
      encoderImplementation: o.encoderImplementation ?? null,
      totalEncodeTime: o.totalEncodeTime ?? null,
      framesEncoded: o.framesEncoded ?? null,
    };
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
    this.cameraVideoSender = null;
    this.micAudioSender = null;
    this.peerConnection = null;
    this.hasRemoteDescription = false;
    this.pendingIceCandidates = [];
    this.iceRestartInProgress = false;
  }
}

export const webrtcService = new WebRTCService();
