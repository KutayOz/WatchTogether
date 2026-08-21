import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakePeerConnection,
  fakeStatsReport,
  stubDisplayMedia,
  type FakeRtpSender,
} from './testDoubles';
import { formatIceDiagnostics, webrtcService } from './webrtcService';
import { chooseOperatingPoint } from '../hooks/operatingPoint';

/** A concrete operating point, standing in for whatever the link measured. */
const POINT = chooseOperatingPoint(4_000_000, 'motion', 'medium');

/**
 * The camera must never outbid the screen share for uplink.
 *
 * This is measured behaviour, not a guess. On a real session pinned at
 * `qualityLimitationReason: 'bandwidth'` for 20.3 of 20.4 seconds, the two
 * senders had settled at:
 *
 *   camera  640x480 @ 30fps -> 1700 kbps
 *   screen  318x178 @ 28fps ->  600 kbps
 *
 * A webcam thumbnail was taking 74% of a ~2.3 Mbps budget and the shared
 * screen — the thing both people are there to watch — was encoded at 318x178.
 * The camera sender had no maxBitrate at all, so Chrome's default let it climb.
 */

const ICE = { iceServers: [] };

function cameraStream() {
  return new FakeMediaStream(
    [new FakeMediaStreamTrack('video', 'cam-v'), new FakeMediaStreamTrack('audio', 'cam-a')],
    'camera-stream',
  );
}

function screenStream() {
  return new FakeMediaStream(
    [new FakeMediaStreamTrack('video', 'scr-v'), new FakeMediaStreamTrack('audio', 'scr-a')],
    'screen-stream',
  );
}

/** The sender carrying a given track id, as the peer connection sees it. */
function senderFor(pc: FakePeerConnection, trackId: string): FakeRtpSender {
  const found = pc.getSenders().find((s) => s.track?.id === trackId);
  if (!found) throw new Error(`no sender for track ${trackId}`);
  return found;
}

/** A closed-and-reopened service on a fake peer connection the test can inspect. */
async function freshService(): Promise<FakePeerConnection> {
  let pc!: FakePeerConnection;
  webrtcService.close();
  vi.stubGlobal(
    'RTCPeerConnection',
    class {
      constructor() {
        pc = new FakePeerConnection();
        return pc as unknown as RTCPeerConnection;
      }
    },
  );
  await webrtcService.initialize(ICE);
  return pc;
}

describe('webrtcService uplink budget', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  it('caps the camera encoder as soon as it is attached', () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    const camera = senderFor(pc, 'cam-v');
    // Uncapped is the bug: Chrome's default let VGA climb to 1700 kbps.
    expect(camera.maxBitrate).toBeGreaterThan(0);
    expect(camera.maxBitrate).toBeLessThan(1_000_000);
  });

  it('squeezes the camera below the screen share while sharing', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    const camera = senderFor(pc, 'cam-v');
    const screen = senderFor(pc, 'scr-v');

    // The requirement: the shared screen gets the budget, not the thumbnail.
    // Measured failure was the exact inverse — 1700 kbps vs 600 kbps.
    expect(camera.maxBitrate).toBeLessThan(screen.maxBitrate!);
    expect(screen.maxBitrate).toBe(POINT.videoBps);
    // Reinforce the cap with allocator priority, so Chrome drains the camera
    // first when the estimate drops rather than splitting the loss evenly.
    expect(camera.networkPriority).toBe('low');
  });

  it('gives the camera its budget back when the share stops', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );
    const whileSharing = senderFor(pc, 'cam-v').maxBitrate!;

    await webrtcService.stopScreenShare();

    const camera = senderFor(pc, 'cam-v');
    expect(camera.maxBitrate).toBeGreaterThan(whileSharing);
    expect(camera.networkPriority).not.toBe('low');
    // Full resolution again — the thumbnail is the main view once more.
    expect(camera.scaleResolutionDownBy).toBeUndefined();
  });

  it('shrinks the camera resolution while sharing', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    // Holding 640x480 inside a 150 kbps ceiling spends the budget on noise.
    // Told to shrink, the encoder spends it on a clean small picture.
    expect(senderFor(pc, 'cam-v').scaleResolutionDownBy).toBeGreaterThan(1);
    // The screen share must NOT be pinned — it needs to pick its own resolution.
    expect(senderFor(pc, 'scr-v').scaleResolutionDownBy).toBeUndefined();
  });
});

/**
 * Codec choice is the only lever that improves the picture without taking
 * bandwidth from something else. The measured session negotiated VP8
 * (`encoder: libvpx`) and spent its whole life bandwidth-limited.
 */
describe('webrtcService screen share codec', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  /** getCapabilities, in the order a browser that prefers VP8 would report. */
  function stubCodecs(mimeTypes: string[]): void {
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({ codecs: mimeTypes.map((mimeType) => ({ mimeType })) }),
    });
  }

  it('offers VP9 ahead of VP8 for the screen share', async () => {
    stubCodecs(['video/VP8', 'video/rtx', 'video/VP9', 'video/H264']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    const offered = pc.transceiverFor('scr-v').codecPreferences;
    expect(offered?.[0]?.mimeType).toBe('video/VP9');
    // Promote-only: everything else keeps its original relative order, so RTX
    // and friends are not reshuffled behind our backs.
    expect(offered?.map((c) => c.mimeType)).toEqual([
      'video/VP9',
      'video/VP8',
      'video/rtx',
      'video/H264',
    ]);
  });

  it('falls back to H.264 once the VP9 encode cannot keep up', async () => {
    // The revert the original comment on preferVp9 nominated — "if this flips
    // the limitation from 'bandwidth' to 'cpu', this is the change to revert" —
    // performed by the session on itself. H.264 because it is the one codec
    // with hardware encode essentially everywhere, which is the whole point.
    stubCodecs(['video/VP8', 'video/VP9', 'video/H264']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );
    expect(pc.transceiverFor('scr-v').codecPreferences?.[0]?.mimeType).toBe('video/VP9');

    expect(webrtcService.downgradeScreenCodec()).toBe(true);

    expect(pc.transceiverFor('scr-v').codecPreferences?.[0]?.mimeType).toBe('video/H264');
    expect(webrtcService.getScreenCodec()).toBe('h264');
  });

  it('will not switch codec twice in one share', async () => {
    // A codec that oscillates is worse than a suboptimal one: every switch
    // costs the viewer a decoder teardown and a keyframe. The caller reads the
    // false and skips the renegotiation.
    stubCodecs(['video/VP8', 'video/VP9', 'video/H264']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    expect(webrtcService.downgradeScreenCodec()).toBe(true);
    expect(webrtcService.downgradeScreenCodec()).toBe(false);
  });

  it('has nothing to downgrade when nobody is sharing', async () => {
    stubCodecs(['video/VP8', 'video/VP9', 'video/H264']);
    expect(webrtcService.downgradeScreenCodec()).toBe(false);
  });

  it('starts the next share from VP9 again', async () => {
    // A 720p window may run in VP9 on the very machine where a 4K one could
    // not, so the downgrade is a fact about one share, not about the machine.
    stubCodecs(['video/VP8', 'video/VP9', 'video/H264']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    const stream = screenStream() as unknown as MediaStream;
    await webrtcService.addScreenShareTracks(stream, POINT);

    webrtcService.downgradeScreenCodec();
    expect(webrtcService.getScreenCodec()).toBe('h264');

    await webrtcService.stopScreenShare();
    expect(webrtcService.getScreenCodec()).toBe('vp9');
  });

  it('prefers H.264 with packetization-mode=1 over mode 0', async () => {
    // Mode 0 cannot fragment a NAL unit across RTP packets, so every large
    // frame has to fit an MTU — exactly the frames a screen share produces.
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [
          { mimeType: 'video/VP8' },
          { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=0;profile-level-id=42e01f' },
          { mimeType: 'video/H264', sdpFmtpLine: 'packetization-mode=1;profile-level-id=42e01f' },
        ],
      }),
    });
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    webrtcService.downgradeScreenCodec();

    const offered = pc.transceiverFor('scr-v').codecPreferences;
    expect(offered?.[0]?.sdpFmtpLine).toContain('packetization-mode=1');
  });

  it('leaves the codec order alone when VP9 is unavailable', async () => {
    stubCodecs(['video/VP8', 'video/H264']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    // Untouched, not reordered into some guess at a preference.
    expect(pc.transceiverFor('scr-v').codecPreferences).toBeNull();
  });

  it('offers VP9 profile 0 ahead of profile 2', async () => {
    // The old filter promoted every VP9 entry while preserving the browser's
    // own order, so a profile-2 (10-bit 4:2:0) entry listed first was what
    // actually got offered — more CPU and more bits to carry 8-bit content.
    vi.stubGlobal('RTCRtpSender', {
      getCapabilities: () => ({
        codecs: [
          { mimeType: 'video/VP8' },
          { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=2' },
          { mimeType: 'video/VP9', sdpFmtpLine: 'profile-id=0' },
        ],
      }),
    });
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    const offered = pc.transceiverFor('scr-v').codecPreferences;
    expect(offered?.[0]?.sdpFmtpLine).toBe('profile-id=0');
    expect(offered?.[1]?.sdpFmtpLine).toBe('profile-id=2');
  });

  it('applies the bitrate ceiling even when localStorage is unusable', async () => {
    // A `typeof localStorage !== 'undefined'` guard is not enough — the object
    // can exist while getItem does not, and privacy settings can make it throw.
    // This matters because codec selection runs inside the same try block as
    // setParameters: a throw there silently leaves the share UNCAPPED, which is
    // the exact failure the encoder ceiling exists to prevent.
    vi.stubGlobal('localStorage', {});
    stubCodecs(['video/VP8', 'video/VP9']);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    expect(senderFor(pc, 'scr-v').maxBitrate).toBe(POINT.videoBps);
    expect(pc.transceiverFor('scr-v').codecPreferences?.[0]?.mimeType).toBe('video/VP9');
  });

  it('still applies the bitrate ceiling when codec capabilities are missing', async () => {
    // A browser without RTCRtpSender.getCapabilities must not cost us the cap:
    // preferVp9 runs inside the same try block as setParameters.
    vi.stubGlobal('RTCRtpSender', undefined);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );

    expect(senderFor(pc, 'scr-v').maxBitrate).toBe(POINT.videoBps);
    expect(senderFor(pc, 'cam-v').maxBitrate).toBeLessThan(POINT.videoBps);
  });
});

/**
 * Capture geometry.
 *
 * captureScreen had no coverage at all, which is how it shipped requesting
 * `max: 3840/2160/60` for every preset regardless of what was chosen — on a 4K
 * desktop the track then arrives at 3840x2160 and Chrome's quality scaler steps
 * 2160 -> 1440 -> 1080 -> 720, so any pressure lands two steps below 1080p and
 * every frame pays a 4K->1080 downscale before it reaches the encoder.
 */
describe('webrtcService capture geometry', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'mediaDevices');
  });

  it('pins capture to the chosen operating point, not to 4K', async () => {
    const { calls } = stubDisplayMedia(screenStream());

    await webrtcService.captureScreen(chooseOperatingPoint(2_300_000, 'film'));

    const video = calls[0].video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 1920, max: 1920 });
    expect(video.height).toEqual({ ideal: 1080, max: 1080 });
    // Film is 24 fps at source; asking for 30 divides the budget over 25% more
    // frames than carry any information.
    expect(video.frameRate).toEqual({ ideal: 24, max: 24 });
  });

  it('still allows 4K60 when the ceiling and the budget both permit it', async () => {
    // Proves the constraint is derived from the point rather than hardcoded.
    const { calls } = stubDisplayMedia(screenStream());

    await webrtcService.captureScreen(chooseOperatingPoint(28_000_000, 'games', 'extreme'));

    const video = calls[0].video as MediaTrackConstraints;
    expect(video.width).toEqual({ ideal: 3840, max: 3840 });
    expect(video.frameRate).toEqual({ ideal: 60, max: 60 });
  });

  it('never offers this app\'s own tab as a share target', async () => {
    const { calls } = stubDisplayMedia(screenStream());
    await webrtcService.captureScreen(chooseOperatingPoint(2_000_000, 'film'));
    // Cast: the DOM lib bundled here predates selfBrowserSurface/surfaceSwitching.
    const options = calls[0] as DisplayMediaStreamOptions & { selfBrowserSurface?: string };
    expect(options.selfBrowserSurface).toBe('exclude');
  });

  it('restores full resolution when the operating point grows again', async () => {
    // The stuck-at-720p bug, end to end. updateScreenShareQuality re-applied
    // ONLY frameRate, so a track once clamped small stayed small for the rest
    // of the session no matter how far the ceiling was later raised.
    const stream = screenStream();
    stubDisplayMedia(stream);

    const small = chooseOperatingPoint(1_000_000, 'film');
    expect(small.height).toBe(720); // precondition: the budget really did clamp it

    const { stream: captured } = await webrtcService.captureScreen(small);
    await webrtcService.addScreenShareTracks(captured, small);

    const track = stream.getVideoTracks()[0];
    await webrtcService.updateScreenShareQuality(chooseOperatingPoint(2_300_000, 'film'));

    // Geometry AND frame rate, in one call — a second applyConstraints replaces
    // the whole set, so a frameRate-only call would silently clear the geometry.
    expect(track.lastConstraints).toEqual({
      width: { ideal: 1920, max: 1920 },
      height: { ideal: 1080, max: 1080 },
      frameRate: { ideal: 24, max: 24 },
    });
  });

  it('does not touch the capturer for a bitrate-only change', async () => {
    // The bitrate moves far more often than the resolution does — a wobbling
    // estimate every three seconds must not make the capturer renegotiate its
    // pipeline for a picture that is the same size it already was.
    const stream = screenStream();
    stubDisplayMedia(stream);

    const point = chooseOperatingPoint(2_300_000, 'film');
    const { stream: captured } = await webrtcService.captureScreen(point);
    await webrtcService.addScreenShareTracks(captured, point);

    const track = stream.getVideoTracks()[0];
    track.constraints.length = 0;

    // Same geometry, slightly different budget.
    const nudged = { ...point, videoBps: point.videoBps - 25_000 };
    await webrtcService.updateScreenShareQuality(nudged);

    expect(track.constraints).toHaveLength(0);
    // The encoder ceiling still moved, though.
    expect(senderFor(pc, 'scr-v').maxBitrate).toBe(nudged.videoBps);
  });

  it('leaves the capturer alone when the picture gets smaller', async () => {
    // Downward moves need no capturer change at all: the encoder's own scaler
    // handles them, which is exactly why applyVideoEncoding leaves
    // scaleResolutionDownBy unpinned. Restarting the capture pipeline costs the
    // viewer a keyframe and a decoder re-init for a change the encoder was
    // going to make anyway.
    const stream = screenStream();
    stubDisplayMedia(stream);

    const big = chooseOperatingPoint(2_300_000, 'film');
    const { stream: captured } = await webrtcService.captureScreen(big);
    await webrtcService.addScreenShareTracks(captured, big);

    const track = stream.getVideoTracks()[0];
    track.constraints.length = 0;

    const small = chooseOperatingPoint(1_000_000, 'film');
    expect(small.height).toBe(720); // precondition: it really did shrink
    await webrtcService.updateScreenShareQuality(small);

    expect(track.constraints).toHaveLength(0);
    // The encoder ceiling still came down, which is the part that matters.
    expect(senderFor(pc, 'scr-v').maxBitrate).toBe(small.videoBps);
  });

  it('measures a raise against what is CAPTURED, not against the last ask', async () => {
    // Down then back up to a size we never stopped capturing. `currentPoint`
    // conflated the ask with the capture, so this counted as a change twice and
    // restarted the pipeline on the way out and again on the way back.
    const stream = screenStream();
    stubDisplayMedia(stream);

    const big = chooseOperatingPoint(2_300_000, 'film');
    const { stream: captured } = await webrtcService.captureScreen(big);
    await webrtcService.addScreenShareTracks(captured, big);

    const track = stream.getVideoTracks()[0];
    track.constraints.length = 0;

    await webrtcService.updateScreenShareQuality(chooseOperatingPoint(1_000_000, 'film'));
    await webrtcService.updateScreenShareQuality(big);

    expect(track.constraints).toHaveLength(0);
  });

  it('will not restart the capturer twice inside the hysteresis window', async () => {
    // The budget probes upward every 9 s and reverts exactly on failure. Left
    // unguarded, a budget wandering across a rung boundary would restart the
    // capture on every cycle — a stutter every nine seconds, for the whole film.
    vi.useFakeTimers();
    try {
      const stream = screenStream();
      stubDisplayMedia(stream);

      const small = chooseOperatingPoint(1_000_000, 'film');
      const { stream: captured } = await webrtcService.captureScreen(small);
      await webrtcService.addScreenShareTracks(captured, small);

      const track = stream.getVideoTracks()[0];
      track.constraints.length = 0;

      // The first raise after a capture is always allowed.
      await webrtcService.updateScreenShareQuality(chooseOperatingPoint(2_300_000, 'film'));
      expect(track.constraints).toHaveLength(1);

      // A second one, moments later, is not.
      await webrtcService.updateScreenShareQuality(
        chooseOperatingPoint(15_000_000, 'film', 'extreme'),
      );
      expect(track.constraints).toHaveLength(1);

      // Once the window has passed, it is.
      vi.advanceTimersByTime(30_001);
      await webrtcService.updateScreenShareQuality(
        chooseOperatingPoint(15_000_000, 'film', 'extreme'),
      );
      expect(track.constraints).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('re-asserts geometry after the user switches shared surface', async () => {
    const stream = screenStream();
    stubDisplayMedia(stream);

    const point = chooseOperatingPoint(2_300_000, 'film');
    const { stream: captured } = await webrtcService.captureScreen(point);
    await webrtcService.addScreenShareTracks(captured, point);

    const track = stream.getVideoTracks()[0];
    track.constraints.length = 0;
    // surfaceSwitching lets the user change what they share mid-stream; the new
    // surface arrives with the browser's own settings and our pinning gone.
    track.emit('configurationchange');
    await Promise.resolve();

    expect(track.lastConstraints).toMatchObject({ width: { max: 1920 } });
    expect(track.contentHint).toBe('motion');
  });

  it('follows the ask down once it is two rungs away', async () => {
    // The gap the encoder was never going to close on its own. A budget
    // collapse had walked the ask to 640x360 while the capturer sat at the
    // 1280x678 it had grown to, and with one frame a second arriving there was
    // nothing to make the encoder scale down: `asked 640x360@30 / sending
    // 1280x678@1` for twenty seconds. When motion resumed, the first thing the
    // encoder had to do was four times the pixels the budget was sized for.
    const stream = screenStream();
    stubDisplayMedia(stream);

    const big = chooseOperatingPoint(2_300_000, 'film');
    const { stream: captured } = await webrtcService.captureScreen(big);
    await webrtcService.addScreenShareTracks(captured, big);

    const track = stream.getVideoTracks()[0];
    track.constraints.length = 0;

    const tiny = chooseOperatingPoint(320_000, 'film');
    // Precondition: two rungs, not one. One rung stays with the encoder — the
    // test above this one is the other half of that pair.
    expect(tiny.width * tiny.height).toBeLessThan(big.width * big.height * 0.35);
    await webrtcService.updateScreenShareQuality(tiny);

    expect(track.constraints).toHaveLength(1);
    expect(track.lastConstraints).toMatchObject({ width: { max: tiny.width } });
  });
});

/**
 * The microphone had no ceiling and no line in any budget — attachLocalStream
 * recorded the video sender and dropped the audio one on the floor.
 */
describe('webrtcService mic budget', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  it('caps the mic and keeps it below the screen share', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(screenStream() as unknown as MediaStream, POINT);

    const mic = senderFor(pc, 'cam-a');
    expect(mic.maxBitrate).toBeGreaterThan(0);
    expect(mic.maxBitrate).toBeLessThan(senderFor(pc, 'scr-v').maxBitrate!);
    // Voice is the last thing that should break: a call where the picture
    // softens is still a call.
    expect(mic.networkPriority).toBe('high');
  });

  it('buys the camera back from frame rate rather than shrinking it further', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(screenStream() as unknown as MediaStream, POINT);

    const camera = senderFor(pc, 'cam-v');
    // A corner thumbnail is a near-static talking head; temporal detail is the
    // first thing nobody is looking at once there is a film next to it.
    expect(camera.maxFramerate).toBeLessThanOrEqual(10);

    await webrtcService.stopScreenShare();
    expect(senderFor(pc, 'cam-v').maxFramerate).toBeUndefined();
  });
});

/**
 * Which sender is the camera's.
 *
 * "The first video sender" is only the camera by accident of ordering, and the
 * accident stops holding as soon as the camera is toggled off: replaceTrack(null)
 * leaves the camera's sender in place with no track, so a scan for a *live* video
 * sender walks straight past it and lands on the screen share. Everything that
 * hot-swaps the outgoing camera frame then aims at the wrong sender, and the peer
 * — with no renegotiation and no error to explain it — watches the shared screen
 * turn into a webcam.
 */
describe('webrtcService camera sender identity', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  afterEach(() => {
    Reflect.deleteProperty(globalThis.navigator, 'mediaDevices');
  });

  /** getUserMedia, answering with a camera the test can recognise by track id. */
  function stubCameraDevice(track: FakeMediaStreamTrack): void {
    const stream = new FakeMediaStream([track], 'camera-stream-2');
    Object.defineProperty(globalThis.navigator, 'mediaDevices', {
      configurable: true,
      value: { getUserMedia: async () => stream as unknown as MediaStream },
    });
  }

  /** Camera off, then a share started — the state where the senders disagree. */
  async function cameraOffWhileSharing() {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    const camera = senderFor(pc, 'cam-v');

    await webrtcService.toggleVideo(false);
    // The sender outlives the track: this is what the "first live video sender"
    // scan trips over.
    expect(camera.track).toBeNull();

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      POINT,
    );
    return { camera, screen: senderFor(pc, 'scr-v') };
  }

  it('re-acquires the camera onto the camera sender, leaving the share alone', async () => {
    const { camera, screen } = await cameraOffWhileSharing();
    stubCameraDevice(new FakeMediaStreamTrack('video', 'cam-v2'));

    await webrtcService.toggleVideo(true);

    // The requirement: turning the camera back on is invisible to the viewer's
    // screen share. The bug replaced it with the webcam feed.
    expect(screen.track?.id).toBe('scr-v');
    expect(camera.track?.id).toBe('cam-v2');
  });

  it('swaps a blurred camera track onto the camera sender, leaving the share alone', async () => {
    const { camera, screen } = await cameraOffWhileSharing();
    const blurred = new FakeMediaStreamTrack('video', 'blur-v');

    const applied = await webrtcService.replaceVideoTrack(
      blurred as unknown as MediaStreamTrack,
    );

    expect(applied).toBe(true);
    expect(screen.track?.id).toBe('scr-v');
    expect(camera.track?.id).toBe('blur-v');
  });
});

/*
 * Observed on a real session (chrome://webrtc-internals, 2026-08-07), sharer
 * side, with a camera up alongside the share:
 *
 *   outbound-rtp (kind=video, mid=4, frameHeight=1078, VP9 profile-id=0)  <- screen
 *   outbound-rtp (kind=video, mid=1, frameHeight=240,  VP8)               <- camera
 *
 * The diagnostics line was blank for the whole session and useSenderHealth —
 * the control loop's only input — saw nothing, so the operating point never
 * adapted. Two outbound video streams is the normal case, not the edge case.
 */
describe('webrtcService outbound screen stats', () => {
  let pc: FakePeerConnection;

  const screenRtp = {
    id: 'OT01V-screen',
    type: 'outbound-rtp',
    kind: 'video',
    mediaSourceId: 'MS-screen',
    frameWidth: 1920,
    frameHeight: 1078,
    framesPerSecond: 24,
    targetBitrate: 1_900_000,
    qualityLimitationReason: 'none',
    encoderImplementation: 'libvpx',
  };
  const cameraRtp = {
    id: 'OT01V-camera',
    type: 'outbound-rtp',
    kind: 'video',
    mediaSourceId: 'MS-camera',
    frameWidth: 320,
    frameHeight: 240,
    framesPerSecond: 8,
    targetBitrate: 64_000,
    qualityLimitationReason: 'none',
  };
  const sources = [
    { id: 'MS-screen', type: 'media-source', trackIdentifier: 'scr-v' },
    { id: 'MS-camera', type: 'media-source', trackIdentifier: 'cam-v' },
  ];

  beforeEach(async () => {
    pc = await freshService();
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(screenStream() as unknown as MediaStream, POINT);
  });

  it('reports the screen, not the camera, when both are sending', async () => {
    senderFor(pc, 'scr-v').stats = fakeStatsReport([screenRtp, cameraRtp, ...sources]);

    const stats = await webrtcService.getOutboundScreenStats();

    expect(stats?.frameHeight).toBe(1078);
    expect(stats?.targetBitrate).toBe(1_900_000);
  });

  it('falls back to the connection report when the sender reference is stale', async () => {
    // A stale sender is indistinguishable from a healthy one until you ask it
    // for stats and get nothing back. Returning null there is what blanked the
    // readout and starved the control loop.
    senderFor(pc, 'scr-v').stats = fakeStatsReport([]);
    pc.stats = fakeStatsReport([screenRtp, cameraRtp, ...sources]);

    const stats = await webrtcService.getOutboundScreenStats();

    expect(stats?.frameHeight).toBe(1078);
    expect(stats?.qualityLimitationReason).toBe('none');
  });

  it('prefers the larger picture when the report omits the media-source link', async () => {
    senderFor(pc, 'scr-v').stats = fakeStatsReport([
      { ...screenRtp, mediaSourceId: undefined },
      { ...cameraRtp, mediaSourceId: undefined },
    ]);

    const stats = await webrtcService.getOutboundScreenStats();

    expect(stats?.frameHeight).toBe(1078);
  });

  it('reports nothing rather than guessing when there is no video at all', async () => {
    senderFor(pc, 'scr-v').stats = fakeStatsReport([
      { id: 'OT01A', type: 'outbound-rtp', kind: 'audio' },
    ]);
    pc.stats = fakeStatsReport([]);

    expect(await webrtcService.getOutboundScreenStats()).toBeNull();
  });
});

/**
 * Why a session ended up relayed over TCP.
 *
 * The reported failure showed `path: relayed (turn/tcp) · 231 ms` and nothing
 * else. Three different causes produce that identical line — UDP to the TURN
 * server being dropped, no relay/udp candidate ever gathered, or a succeeded
 * UDP pair losing nomination — and they want three different fixes. This is the
 * readout that tells them apart.
 */
describe('webrtcService ice diagnostics', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
    pc = await freshService();
  });

  /** A gathered UDP relay whose STUN requests go unanswered, plus a live TCP one. */
  function tcpRelayFallbackStats() {
    return fakeStatsReport([
      { id: 'T', type: 'transport', selectedCandidatePairId: 'P-tcp' },
      {
        id: 'L-udp',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'udp',
        url: 'turn:turn.example.net:3478?transport=udp',
        networkType: 'wifi',
        address: '203.0.113.7',
        ip: '203.0.113.7',
      },
      {
        id: 'L-tcp',
        type: 'local-candidate',
        candidateType: 'relay',
        protocol: 'udp',
        relayProtocol: 'tcp',
        url: 'turn:turn.example.net:3478?transport=tcp',
        networkType: 'wifi',
        address: '203.0.113.7',
      },
      { id: 'R', type: 'remote-candidate', candidateType: 'relay', protocol: 'udp' },
      {
        id: 'P-udp',
        type: 'candidate-pair',
        state: 'in-progress',
        localCandidateId: 'L-udp',
        remoteCandidateId: 'R',
        requestsSent: 9,
        responsesReceived: 0,
      },
      {
        id: 'P-tcp',
        type: 'candidate-pair',
        state: 'succeeded',
        nominated: true,
        localCandidateId: 'L-tcp',
        remoteCandidateId: 'R',
        requestsSent: 4,
        responsesReceived: 4,
        currentRoundTripTime: 0.231,
        availableOutgoingBitrate: 30_000,
        bytesSent: 120_000,
      },
    ]);
  }

  it('separates a blocked UDP relay from one that was never gathered', async () => {
    pc.stats = tcpRelayFallbackStats();

    const d = await webrtcService.getIceDiagnostics();

    // The discriminator: the UDP relay EXISTS, so gathering worked. Its pair
    // sent requests and got nothing back — the path is blocked, not missing.
    const udp = d!.local.find((c) => c.relayProtocol === 'udp');
    expect(udp).toBeDefined();
    const udpPair = d!.pairs.find((p) => p.localCandidateId === 'L-udp');
    expect(udpPair).toMatchObject({ requestsSent: 9, responsesReceived: 0 });

    // And the one that actually carries media is marked, both ways.
    const tcpPair = d!.pairs.find((p) => p.localCandidateId === 'L-tcp');
    expect(tcpPair).toMatchObject({ selected: true, nominated: true, rttMs: 231 });
  });

  it('reports which servers were offered, not just which candidates appeared', async () => {
    // "No relay/udp candidate" means something different depending on whether a
    // UDP TURN URL was ever in the config. Only the retained config knows.
    webrtcService.close();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          pc = new FakePeerConnection();
          return pc as unknown as RTCPeerConnection;
        }
      },
    );
    await webrtcService.initialize({
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'turn:turn.example.net:3478?transport=udp', username: 'u', credential: 'secret' },
      ],
    });
    pc.stats = tcpRelayFallbackStats();

    const d = await webrtcService.getIceDiagnostics();
    expect(d!.offeredUrls).toEqual([
      'stun:stun.l.google.com:19302',
      'turn:turn.example.net:3478?transport=udp',
    ]);
  });

  it('never puts an address or a credential in the formatted dump', async () => {
    // This string exists to be pasted into a bug report.
    webrtcService.close();
    vi.stubGlobal(
      'RTCPeerConnection',
      class {
        constructor() {
          pc = new FakePeerConnection();
          return pc as unknown as RTCPeerConnection;
        }
      },
    );
    await webrtcService.initialize({
      iceServers: [
        { urls: 'turn:turn.example.net:3478', username: 'user-42', credential: 'sup3rsecret' },
      ],
    });
    pc.stats = tcpRelayFallbackStats();

    const text = formatIceDiagnostics((await webrtcService.getIceDiagnostics())!);

    expect(text).not.toContain('203.0.113.7');
    expect(text).not.toContain('sup3rsecret');
    expect(text).not.toContain('user-42');
    // But it must still be useful.
    expect(text).toContain('relay/udp');
    expect(text).toContain('SELECTED');
    expect(text).toContain('req=9 resp=0');
  });
});
