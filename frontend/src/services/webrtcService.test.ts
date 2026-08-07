import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakePeerConnection,
  stubDisplayMedia,
  type FakeRtpSender,
} from './testDoubles';
import { webrtcService } from './webrtcService';
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
