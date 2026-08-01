import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  FakeMediaStream,
  FakeMediaStreamTrack,
  FakePeerConnection,
  type FakeRtpSender,
} from './testDoubles';
import { webrtcService } from './webrtcService';
import { QUALITY_PRESETS } from '../types';

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
      'medium',
    );

    const camera = senderFor(pc, 'cam-v');
    const screen = senderFor(pc, 'scr-v');

    // The requirement: the shared screen gets the budget, not the thumbnail.
    // Measured failure was the exact inverse — 1700 kbps vs 600 kbps.
    expect(camera.maxBitrate).toBeLessThan(screen.maxBitrate!);
    expect(screen.maxBitrate).toBe(QUALITY_PRESETS.medium.video.bitrate);
    // Reinforce the cap with allocator priority, so Chrome drains the camera
    // first when the estimate drops rather than splitting the loss evenly.
    expect(camera.networkPriority).toBe('low');
  });

  it('gives the camera its budget back when the share stops', async () => {
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);
    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      'medium',
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
      'medium',
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
      'medium',
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
      'medium',
    );

    // Untouched, not reordered into some guess at a preference.
    expect(pc.transceiverFor('scr-v').codecPreferences).toBeNull();
  });

  it('still applies the bitrate ceiling when codec capabilities are missing', async () => {
    // A browser without RTCRtpSender.getCapabilities must not cost us the cap:
    // preferVp9 runs inside the same try block as setParameters.
    vi.stubGlobal('RTCRtpSender', undefined);
    webrtcService.attachLocalStream(cameraStream() as unknown as MediaStream);

    await webrtcService.addScreenShareTracks(
      screenStream() as unknown as MediaStream,
      'medium',
    );

    expect(senderFor(pc, 'scr-v').maxBitrate).toBe(QUALITY_PRESETS.medium.video.bitrate);
    expect(senderFor(pc, 'cam-v').maxBitrate).toBeLessThan(
      QUALITY_PRESETS.medium.video.bitrate,
    );
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
      'medium',
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
