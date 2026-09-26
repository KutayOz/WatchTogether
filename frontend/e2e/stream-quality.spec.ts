import { expect, test, type Browser, type Page, type TestInfo } from '@playwright/test';
import type { OperatingPoint } from '../src/hooks/operatingPoint';
import type { webrtcService } from '../src/services/webrtcService';

type Service = typeof webrtcService;
type PeerHarness = {
  service: Service;
  point: OperatingPoint;
  connection: RTCPeerConnectionState;
  errors: string[];
  videos: Map<string, HTMLVideoElement>;
  audioTracks: Map<string, MediaStreamTrack>;
  timers: number[];
  startShare(): Promise<string>;
};

declare global {
  interface Window {
    streamQualityPeer: PeerHarness;
    relayQualityIce(candidate: string): Promise<void>;
  }
}

/**
 * Actual Chromium codecs, RTP, ICE and rendering, with the production service
 * on both peers. Only the display picker and signaling transport are replaced:
 * a moving 1080p canvas supplies deterministic frames, and Playwright relays
 * the same serialized SDP/ICE that the room normally forwards. No TURN server
 * or credentials are required for this local host-candidate connection.
 *
 * This verifies the media pipeline, not WAN throughput or capture performance
 * on the user's desktop. Test artifacts retain the measured RTP statistics.
 */
async function createPeers(browser: Browser, mode: 'film' | 'motion' = 'film') {
  const contexts = await Promise.all([browser.newContext(), browser.newContext()]);
  const pages = await Promise.all(contexts.map((context) => context.newPage()));
  for (const [index, page] of pages.entries()) {
    await page.exposeFunction('relayQualityIce', async (candidate: string) => {
      await pages[1 - index].evaluate(
        (serialized) => window.streamQualityPeer.service.addIceCandidate(serialized),
        candidate,
      );
    });
    // Keep React's room, camera preflight and animation loops out of a test of
    // encoder capacity. Import the real module through the existing Vite server.
    await page.route('**/__stream-quality-test', (route) => route.fulfill({
      contentType: 'text/html',
      body: '<!doctype html><title>WebRTC quality test</title><body></body>',
    }));
    await page.goto('/__stream-quality-test');
    await page.evaluate(async (contentMode) => {
      const servicePath = '/src/services/webrtcService.ts';
      const policyPath = '/src/hooks/operatingPoint.ts';
      const { webrtcService: service } = await import(/* @vite-ignore */ servicePath) as { webrtcService: Service };
      const { chooseOperatingPoint } = await import(/* @vite-ignore */ policyPath) as typeof import('../src/hooks/operatingPoint');
      const point = chooseOperatingPoint(10_000_000, contentMode, 'high');
      const peer: PeerHarness = {
        service, point, connection: 'new', errors: [], videos: new Map(), audioTracks: new Map(), timers: [],
        startShare: async () => {
          const canvas = document.createElement('canvas');
          canvas.width = 1920;
          canvas.height = 1080;
          const ctx = canvas.getContext('2d', { alpha: false })!;
          let frame = 0;
          const draw = () => {
            frame += 1;
            ctx.fillStyle = '#19213d';
            ctx.fillRect(0, 0, canvas.width, canvas.height);
            // Moving broad shapes and fine details: more than a static slide,
            // without random noise that overwhelms every practical codec.
            for (let i = 0; i < 18; i += 1) {
              ctx.fillStyle = `hsl(${i * 19}, 65%, 55%)`;
              ctx.fillRect((i * 119 + frame * (i % 3 + 1) * 2) % 1920, i * 59, 260, 43);
            }
            ctx.fillStyle = 'white';
            ctx.font = '48px sans-serif';
            ctx.fillText(`1080p film frame ${frame}`, 50, 1040);
          };
          draw();
          const stream = canvas.captureStream(30);
          // A distinct real audio track exercises the soundtrack sender too;
          // all four senders now share the same transport budget.
          const soundtrack = service.getLocalStream()?.getAudioTracks()[0]?.clone();
          if (soundtrack) stream.addTrack(soundtrack);
          peer.timers.push(window.setInterval(draw, 1000 / 30));
          // Exercise captureScreen's real constraint/contentHint setup too.
          Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
            configurable: true,
            value: async () => stream,
          });
          const captured = await service.captureScreen(point);
          await service.addScreenShareTracks(captured.stream, point);
          return captured.streamId;
        },
      };
      window.streamQualityPeer = peer;
      service.setHandlers({
        onIceCandidate: (candidate) => {
          void window.relayQualityIce(JSON.stringify(candidate.toJSON())).catch(
            (error: unknown) => peer.errors.push(String(error)),
          );
        },
        onConnectionStateChange: (state) => { peer.connection = state; },
        onTrack: (event) => {
          const id = event.streams[0]?.id ?? event.track.id;
          if (event.track.kind === 'audio') {
            peer.audioTracks.set(id, event.track);
            return;
          }
          if (event.track.kind !== 'video') return;
          const video = document.createElement('video');
          video.autoplay = true;
          video.muted = true;
          video.playsInline = true;
          video.style.width = '480px';
          video.srcObject = new MediaStream([event.track]);
          document.body.append(video);
          peer.videos.set(id, video);
          void video.play().catch((error: unknown) => peer.errors.push(String(error)));
        },
      });
      await service.initialize({ iceServers: [] });
      // Real companion camera/mic tracks also compete for the bundled transport.
      const camera = await navigator.mediaDevices.getUserMedia({ video: { width: 640, height: 480 }, audio: true });
      service.attachLocalStream(camera);
    }, mode);
  }
  return {
    sender: pages[0], receiver: pages[1],
    close: async () => {
      for (const page of pages) {
        await page.evaluate(() => {
          window.streamQualityPeer.timers.forEach(clearInterval);
          window.streamQualityPeer.service.close();
        }).catch(() => {});
      }
      await Promise.all(contexts.map((context) => context.close()));
    },
  };
}

async function negotiate(sender: Page, receiver: Page, restartIce = false) {
  const offer = await sender.evaluate(
    (restart) => window.streamQualityPeer.service.createOffer(restart), restartIce,
  );
  await receiver.evaluate((sdp) => window.streamQualityPeer.service.setRemoteDescription(sdp), offer);
  const answer = await receiver.evaluate(() => window.streamQualityPeer.service.createAnswer());
  await sender.evaluate((sdp) => window.streamQualityPeer.service.setRemoteDescription(sdp), answer);
  await Promise.all([sender, receiver].map((page) => expect.poll(
    () => page.evaluate(() => window.streamQualityPeer.connection), { timeout: 15_000 },
  ).toBe('connected')));
}

async function snapshot(page: Page, streamId: string) {
  return page.evaluate(async (id) => {
    const peer = window.streamQualityPeer;
    const video = peer.videos.get(id);
    const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const report = await peer.service.getStats();
    let inbound: RTCInboundRtpStreamStats | undefined;
    let audioStreamsReceiving = 0;
    let soundtrackPackets = 0;
    report?.forEach((row) => {
      if (row.type === 'inbound-rtp' && row.kind === 'video' && row.trackIdentifier === track?.id) {
        inbound = row as RTCInboundRtpStreamStats;
      }
      if (row.type === 'inbound-rtp' && row.kind === 'audio' && row.packetsReceived > 0) {
        audioStreamsReceiving += 1;
        if (row.trackIdentifier === peer.audioTracks.get(id)?.id) soundtrackPackets = row.packetsReceived;
      }
    });
    const codec = inbound?.codecId ? report?.get(inbound.codecId) : undefined;
    return {
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
      paused: video?.paused ?? true,
      framesDecoded: inbound?.framesDecoded ?? 0,
      framesDropped: inbound?.framesDropped ?? 0,
      timestamp: inbound?.timestamp ?? 0,
      bytesReceived: inbound?.bytesReceived ?? 0,
      codec: codec?.mimeType as string | undefined,
      audioStreamsReceiving,
      soundtrackPackets,
      errors: peer.errors,
    };
  }, streamId);
}

async function waitFor1080p(receiver: Page, streamId: string) {
  await expect.poll(async () => {
    const received = await snapshot(receiver, streamId);
    return received.width === 1920 && received.height === 1080 && received.framesDecoded > 20 && !received.paused;
  }, { timeout: 30_000, message: 'the peer decodes real 1920×1080 frames' }).toBe(true);
}

async function recordSample(sender: Page, receiver: Page, streamId: string, info: TestInfo, label: string, minimumFps = 20) {
  const before = await snapshot(receiver, streamId);
  await receiver.waitForTimeout(5_000);
  const after = await snapshot(receiver, streamId);
  const elapsed = (after.timestamp - before.timestamp) / 1000;
  const decodedFps = (after.framesDecoded - before.framesDecoded) / elapsed;
  const inboundMbps = (after.bytesReceived - before.bytesReceived) * 8 / elapsed / 1_000_000;
  const outbound = await sender.evaluate(() => window.streamQualityPeer.service.getOutboundScreenStats());
  const measurements = { label, before, after, decodedFps, inboundMbps, outbound };
  await info.attach(`${label}.json`, { body: JSON.stringify(measurements, null, 2), contentType: 'application/json' });
  console.log(`[screen-quality] ${JSON.stringify(measurements)}`);
  expect(after.errors).toEqual([]);
  expect(after.audioStreamsReceiving, 'microphone and screen soundtrack both arrive').toBeGreaterThanOrEqual(2);
  expect(after.soundtrackPackets, 'the current soundtrack continues across quality changes').toBeGreaterThan(before.soundtrackPackets);
  expect(after.width).toBe(1920);
  expect(after.height).toBe(1080);
  expect(decodedFps, 'sustained decoded frame rate').toBeGreaterThanOrEqual(minimumFps);
  expect(after.framesDropped - before.framesDropped).toBeLessThanOrEqual(5);
  return measurements;
}

test.describe('Real screen-share encoding', () => {
  // Encoding two 1080p streams in concurrent tests would measure the test
  // runner's CPU contention instead of the media pipeline.
  test.describe.configure({ mode: 'serial', timeout: 90_000 });

  test('sustains 1080p film beside camera/mic and after an ICE restart', async ({ browser }, info) => {
    const peers = await createPeers(browser);
    try {
      const streamId = await peers.sender.evaluate(() => window.streamQualityPeer.startShare());
      await negotiate(peers.sender, peers.receiver);
      await waitFor1080p(peers.receiver, streamId);
      const first = await recordSample(peers.sender, peers.receiver, streamId, info, 'initial-1080p');
      expect(first.after.codec).toMatch(/^video\/(VP9|H264)$/i);

      await negotiate(peers.sender, peers.receiver, true);
      await waitFor1080p(peers.receiver, streamId);
      await recordSample(peers.sender, peers.receiver, streamId, info, 'after-ice-restart');
      expect(await peers.sender.evaluate(() => window.streamQualityPeer.errors)).toEqual([]);
    } finally {
      await peers.close();
    }
  });

  test('sustains 1080p30 through live quality changes and a second share', async ({ browser }, info) => {
    const peers = await createPeers(browser, 'motion');
    try {
      const firstId = await peers.sender.evaluate(() => window.streamQualityPeer.startShare());
      await negotiate(peers.sender, peers.receiver);
      await waitFor1080p(peers.receiver, firstId);
      const settings = await peers.sender.evaluate(async (expectedStreamId) => {
        const peer = window.streamQualityPeer;
        // Read actual native sender parameters. TypeScript private fields are
        // inspected here solely to verify that Chromium accepted the policy.
        const pc = (peer.service as unknown as { peerConnection: RTCPeerConnection }).peerConnection;
        const screenId = peer.service.getScreenStream()!.getVideoTracks()[0].id;
        const screen = pc.getSenders().find((sender) => sender.track?.id === screenId)!;
        const audioId = peer.service.getScreenStream()!.getAudioTracks()[0].id;
        const soundtrack = pc.getSenders().find((sender) => sender.track?.id === audioId)!;
        const camera = pc.getSenders().find((sender) => sender.track?.kind === 'video' && sender !== screen)!;
        const before = screen.getParameters();
        const changed = { ...peer.point, videoBps: Math.floor(peer.point.videoBps * 0.85) };
        const live = await peer.service.updateScreenShareQuality(changed);
        const after = screen.getParameters();
        await peer.service.updateScreenShareQuality(peer.point);
        return {
          point: peer.point, before, after, live,
          camera: camera.getParameters(),
          soundtrack: soundtrack.getParameters(),
          streamUnchanged: peer.service.getScreenStreamId() === expectedStreamId,
        };
      }, firstId);
      expect(settings.before.encodings[0].maxBitrate).toBe(settings.point.videoBps);
      expect(settings.before.encodings[0].maxFramerate).toBe(settings.point.fps);
      expect(settings.before.degradationPreference).toBe('maintain-framerate');
      expect(settings.camera.encodings[0].maxBitrate).toBeLessThanOrEqual(150_000);
      expect(settings.camera.encodings[0].maxFramerate).toBeLessThanOrEqual(10);
      expect(settings.soundtrack.encodings[0].maxBitrate).toBe(settings.point.audioBps);
      expect(settings.after.encodings[0].maxBitrate).toBe(Math.floor(settings.point.videoBps * 0.85));
      expect(settings.live && settings.streamUnchanged).toBe(true);
      await recordSample(peers.sender, peers.receiver, firstId, info, '1080p30-after-bitrate-update', 25);

      // The real encoder must follow policy geometry as well as its bitrate;
      // otherwise a 720p budget can keep trying to encode a 1080p source.
      await peers.sender.evaluate(() => {
        const { service, point } = window.streamQualityPeer;
        return service.updateScreenShareQuality({ ...point, width: 1280, height: 720, videoBps: 3_000_000 });
      });
      await expect.poll(async () => {
        const received = await snapshot(peers.receiver, firstId);
        return [received.width, received.height];
      }, { timeout: 10_000 }).toEqual([1280, 720]);
      await peers.sender.evaluate(() => {
        const { service, point } = window.streamQualityPeer;
        return service.updateScreenShareQuality(point);
      });
      await waitFor1080p(peers.receiver, firstId);
      await recordSample(peers.sender, peers.receiver, firstId, info, '1080p30-after-resolution-recovery', 25);

      expect(await peers.sender.evaluate(() => window.streamQualityPeer.service.stopScreenShare())).toBe(true);
      await negotiate(peers.sender, peers.receiver);
      const secondId = await peers.sender.evaluate(() => window.streamQualityPeer.startShare());
      expect(secondId).not.toBe(firstId);
      await negotiate(peers.sender, peers.receiver);
      await waitFor1080p(peers.receiver, secondId);
      await recordSample(peers.sender, peers.receiver, secondId, info, '1080p30-second-share', 25);
      expect(await peers.sender.evaluate(() => window.streamQualityPeer.errors)).toEqual([]);
    } finally {
      await peers.close();
    }
  });
});
