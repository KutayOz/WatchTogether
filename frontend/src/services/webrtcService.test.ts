import { beforeEach, describe, expect, it, vi } from 'vitest';
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

describe('webrtcService uplink budget', () => {
  let pc: FakePeerConnection;

  beforeEach(async () => {
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
  });
});
