import { expect, test, type Browser, type Page } from '@playwright/test';
import { writeFile } from 'node:fs/promises';
import type { OperatingPoint } from '../src/hooks/operatingPoint';
import type { webrtcService } from '../src/services/webrtcService';

type Service = typeof webrtcService;
type CaptureFixture = {
  paused: boolean;
  frames: number;
  constraints: Array<{ at: number; value: MediaTrackConstraints }>;
};
declare global {
  interface Window { controllerCapture?: CaptureFixture; }
}
const SESSION = 'sess-quality-controller';

/** Only the authenticated HTTP boundary and signaling room are simulated.
 * The real SessionRoom, controller hooks, DataChannel feedback and all native
 * WebRTC media operations run unchanged. Requires the media Playwright project.
 */
async function prepareSession(page: Page, name: string) {
  const user = { username: name, discriminator: '0042', tag: `${name}#0042`, isRootUser: false, hasAcceptedTerms: true };
  await page.addInitScript((identity) => {
    for (const [key, value] of Object.entries(identity)) localStorage.setItem(key, String(value));
    const style = document.createElement('style');
    style.textContent = '*,*::before,*::after{animation-duration:0s!important;animation-delay:0s!important;transition-duration:0s!important}';
    document.addEventListener('DOMContentLoaded', () => document.head.append(style), { once: true });
  }, user);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const json = (body: unknown) => ({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  await page.route('**/api/auth/me', (route) => route.fulfill(json(user)));
  await page.route(`**/api/session/${SESSION}/validate`, (route) => route.fulfill(json({ exists: true, valid: true, participantCount: 0 })));
  await page.route('**/api/session/ice-servers', (route) => route.fulfill(json({ iceServers: [] })));
  await page.route(`**/api/session/${SESSION}/invite`, (route) => route.fulfill(json({
    success: true, inviteUrl: `http://localhost:5173/join/test-${SESSION}`, expiresAt: new Date(Date.now() + 900_000).toISOString(),
  })));
}

async function relaySignalling(pages: Array<{ page: Page; name: string }>, offerer: string) {
  type Socket = { send(message: string): void };
  const sockets = new Map<string, Socket>();
  const sent: Array<{ from: string; t: string }> = [];
  const send = (socket: Socket, t: string, d: unknown) => socket.send(JSON.stringify({ t, d }));
  for (const { page, name } of pages) {
    await page.routeWebSocket(/\/api\/session\/ws\//, (socket) => {
      for (const [otherName, other] of sockets) {
        send(socket, 'ExistingPeer', { name: otherName, sharing: null });
        send(other, 'PeerJoined', { name });
      }
      sockets.set(name, socket);
      send(socket, 'Joined', { you: { userId: `u-${name}`, username: name }, isOfferer: name === offerer, capacity: 2 });
      socket.onMessage((raw) => {
        if (raw.toString() === 'ping') { socket.send('pong'); return; }
        let frame: { t: string; d: Record<string, unknown> };
        try { frame = JSON.parse(raw.toString()); } catch { return; }
        sent.push({ from: name, t: frame.t });
        const peer = [...sockets.entries()].find(([otherName]) => otherName !== name)?.[1];
        if (!peer) return;
        switch (frame.t) {
          case 'offer': send(peer, 'ReceiveOffer', { sdp: frame.d.sdp, name }); break;
          case 'answer': send(peer, 'ReceiveAnswer', { sdp: frame.d.sdp }); break;
          case 'ice': send(peer, 'ReceiveIceCandidate', { c: frame.d.c }); break;
          case 'reoffer': send(peer, 'ReceiveRenegotiationOffer', { sdp: frame.d.sdp }); break;
          case 'reanswer': send(peer, 'ReceiveRenegotiationAnswer', { sdp: frame.d.sdp }); break;
          case 'media': send(peer, 'PeerMediaStateChanged', { name, state: frame.d }); break;
          case 'ss:req': send(peer, 'ScreenShareRequested', { name }); break;
          case 'ss:res': send(peer, 'ScreenShareResponse', { approved: frame.d.approved, name }); break;
          case 'ss:start': send(peer, 'ScreenShareStarted', { name, streamId: frame.d.streamId }); break;
          case 'ss:stop': send(peer, 'ScreenShareStopped', { name }); break;
          case 'leave': sockets.delete(name); send(peer, 'PeerLeft', { name }); break;
        }
      });
    });
  }
  return { sent };
}

/** Observe native messages without replacing the application's handlers. */
async function observeViewerFeedback(page: Page) {
  await page.evaluate(async () => {
    const path = '/src/services/dataChannelService.ts';
    const { dataChannelService } = await import(/* @vite-ignore */ path) as {
      dataChannelService: { control: RTCDataChannel | null };
    };
    const state = window as unknown as { controllerQualityMessages: number };
    state.controllerQualityMessages = 0;
    if (!dataChannelService.control) throw new Error('The application control DataChannel was not created');
    dataChannelService.control.addEventListener('message', (event) => {
      if (typeof event.data !== 'string') return;
      try {
        const message = JSON.parse(event.data) as { t?: string };
        if (message.t === 'quality') state.controllerQualityMessages += 1;
      } catch { /* Ignore unrelated malformed frames just as the application does. */ }
    });
  });
}

async function person(browser: Browser, name: string) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width: 1440, height: 1000 },
  });
  const page = await context.newPage();
  await prepareSession(page, name);
  await page.addInitScript(() => {
    localStorage.setItem('wt:screenShareQuality', 'high');
    localStorage.setItem('wt:contentMode', 'motion');
    Object.defineProperty(navigator.mediaDevices, 'getDisplayMedia', {
      configurable: true,
      value: async () => {
        const capture: CaptureFixture = { paused: false, frames: 0, constraints: [] };
        window.controllerCapture = capture;
        const canvas = document.createElement('canvas');
        canvas.width = 1920;
        canvas.height = 1080;
        const ctx = canvas.getContext('2d', { alpha: false })!;
        let frame = 0;
        const draw = () => {
          if (capture.paused) return;
          frame += 1;
          capture.frames = frame;
          ctx.fillStyle = '#19213d';
          ctx.fillRect(0, 0, 1920, 1080);
          for (let i = 0; i < 18; i += 1) {
            ctx.fillStyle = `hsl(${i * 19}, 65%, 55%)`;
            ctx.fillRect((i * 119 + frame * (i % 3 + 1) * 2) % 1920, i * 59, 260, 43);
          }
          ctx.fillStyle = 'white';
          ctx.font = '48px sans-serif';
          ctx.fillText(`1080p controller integration · ${frame}`, 50, 1040);
        };
        draw();
        const stream = canvas.captureStream(30);
        const track = stream.getVideoTracks()[0];
        const applyConstraints = track.applyConstraints.bind(track);
        track.applyConstraints = async (constraints) => {
          capture.constraints.push({ at: Date.now(), value: structuredClone(constraints ?? {}) });
          await applyConstraints(constraints);
        };
        const timer = window.setInterval(draw, 1000 / 30);
        stream.getVideoTracks()[0].addEventListener('ended', () => clearInterval(timer));
        const modulePath = '/src/services/webrtcService.ts';
        const { webrtcService: service } = await import(/* @vite-ignore */ modulePath) as { webrtcService: Service };
        const soundtrack = service.getLocalStream()?.getAudioTracks()[0]?.clone();
        if (soundtrack) stream.addTrack(soundtrack);
        return stream;
      },
    });
  });
  return page;
}

async function join(page: Page) {
  await page.goto(`/session/${SESSION}`);
  await page.getByRole('button', { name: /^join$/i }).click({ timeout: 20_000 });
  await expect(page.getByRole('button', { name: 'Leave session', exact: true }).first()).toBeVisible({ timeout: 20_000 });
}

async function measure(sender: Page, receiver: Page) {
  const outgoing = await sender.evaluate(async () => {
    const modulePath = '/src/services/webrtcService.ts';
    const { webrtcService: service } = await import(/* @vite-ignore */ modulePath) as { webrtcService: Service };
    const internals = service as unknown as {
      currentPoint: OperatingPoint | null;
      screenVideoSender: RTCRtpSender | null;
    };
    const parameters = internals.screenVideoSender?.getParameters();
    return {
      asked: internals.currentPoint,
      parameters: parameters ? {
        encodings: parameters.encodings,
        degradationPreference: parameters.degradationPreference,
      } : null,
      outbound: await service.getOutboundScreenStats(),
      screenId: service.getScreenStreamId(),
      screenTrackId: service.getScreenStream()?.getVideoTracks()[0]?.id ?? null,
      capture: window.controllerCapture ?? null,
      viewerFeedbackMessages: (window as unknown as { controllerQualityMessages?: number }).controllerQualityMessages ?? 0,
    };
  });
  const incoming = await receiver.evaluate(async (screenTrackId) => {
    const modulePath = '/src/services/webrtcService.ts';
    const { webrtcService: service } = await import(/* @vite-ignore */ modulePath) as { webrtcService: Service };
    // Match the actual SDP track identity instead of guessing by resolution or
    // by the stage's layout classes.
    const video = Array.from(document.querySelectorAll('video')).find((element) =>
      (element.srcObject as MediaStream | null)?.getVideoTracks()[0]?.id === screenTrackId,
    );
    const track = (video?.srcObject as MediaStream | null)?.getVideoTracks()[0];
    const stats = await service.getStats();
    let inbound: RTCInboundRtpStreamStats | undefined;
    stats?.forEach((row) => {
      if (row.type === 'inbound-rtp' && row.kind === 'video' && row.trackIdentifier === track?.id) {
        inbound = row as RTCInboundRtpStreamStats;
      }
    });
    return {
      width: video?.videoWidth ?? 0,
      height: video?.videoHeight ?? 0,
      paused: video?.paused ?? true,
      timestamp: inbound?.timestamp ?? 0,
      framesDecoded: inbound?.framesDecoded ?? 0,
      framesDropped: inbound?.framesDropped ?? 0,
      fps: inbound?.framesPerSecond ?? 0,
      packetsLost: inbound?.packetsLost ?? 0,
    };
  }, outgoing.screenTrackId);
  return { outgoing, incoming };
}

test('the full app sustains requested 1080p30 while its quality controllers and receiver feedback run', async ({ browser }, info) => {
  test.setTimeout(100_000);
  const alice = await person(browser, 'alice');
  const bob = await person(browser, 'bob');
  const pageErrors: string[] = [];
  for (const [name, page] of [['alice', alice], ['bob', bob]] as const) {
    page.on('pageerror', (error) => pageErrors.push(`${name}: ${error.message}`));
  }
  const samples: Awaited<ReturnType<typeof measure>>[] = [];
  try {
    const relay = await relaySignalling([{ page: alice, name: 'alice' }, { page: bob, name: 'bob' }], 'alice');
    await join(alice);
    await join(bob);
    await expect(alice.locator('.room-top__state[data-state="connected"]')).toBeVisible({ timeout: 20_000 });
    await observeViewerFeedback(alice);
    await alice.getByRole('button', { name: /^share screen$/i }).click();
    const request = bob.getByRole('dialog', { name: /alice wants to share their screen/i });
    await expect(request).toBeVisible();
    await request.getByRole('button', { name: /^allow$/i }).click();
    await expect(bob.getByText(/alice is sharing/i)).toBeVisible({ timeout: 15_000 });
    await expect.poll(async () => {
      const sample = await measure(alice, bob);
      return sample.incoming.width === 1920 && sample.incoming.height === 1080 && sample.incoming.framesDecoded > 30;
    }, { timeout: 25_000 }).toBe(true);

    // Longer than the capture cooldown and several independent 3s health,
    // uplink, receiver-feedback and capacity-learning observations. The smaller
    // rendered stage must not override the user's explicit 1080p selection.
    samples.push(await measure(alice, bob));
    for (let i = 0; i < 7; i += 1) {
      await bob.waitForTimeout(5_000);
      samples.push(await measure(alice, bob));
    }
    const first = samples[0].incoming;
    const last = samples.at(-1)!.incoming;
    const decodedFps = (last.framesDecoded - first.framesDecoded) / ((last.timestamp - first.timestamp) / 1000);
    console.log(`[quality-controller] ${JSON.stringify({ decodedFps, samples, pageErrors })}`);
    const measurementsPath = info.outputPath('controller-measurements.json');
    await writeFile(measurementsPath, JSON.stringify({ decodedFps, samples, pageErrors }, null, 2));
    await info.attach('controller-measurements.json', { path: measurementsPath, contentType: 'application/json' });
    for (const sample of samples) {
      expect(sample.outgoing.asked).toMatchObject({ width: 1920, height: 1080, fps: 30 });
      expect(sample.outgoing.parameters?.encodings[0].maxBitrate).toBeGreaterThanOrEqual(3_000_000);
      expect(sample.incoming).toMatchObject({ width: 1920, height: 1080, paused: false });
    }
    expect(decodedFps).toBeGreaterThanOrEqual(25);
    expect(last.framesDropped - first.framesDropped).toBeLessThanOrEqual(10);
    expect(pageErrors).toEqual([]);
    expect(samples.at(-1)!.outgoing.viewerFeedbackMessages, 'actual viewer feedback reaches the sender over its DataChannel').toBeGreaterThanOrEqual(3);
    expect(relay.sent.some((frame) => frame.t === 'ss:start')).toBe(true);
  } finally {
    await Promise.all([
      alice.screenshot({ path: info.outputPath('sender.png'), fullPage: true }).catch(() => {}),
      bob.screenshot({ path: info.outputPath('receiver.png'), fullPage: true }).catch(() => {}),
    ]);
    await Promise.all([alice.context().close(), bob.context().close()]);
  }
});


/** Exercise the same room UI as the sustained test, keeping native media and
 * all controller hooks alive. Each test owns its independent pair of pages.
 */
async function startControllerSession(browser: Browser) {
  const alice = await person(browser, 'alice');
  const bob = await person(browser, 'bob');
  const errors: string[] = [];
  for (const [name, page] of [['alice', alice], ['bob', bob]] as const) {
    page.on('pageerror', (error) => errors.push(`${name}: ${error.message}`));
  }
  const close = () => Promise.all([alice.context().close(), bob.context().close()]);
  try {
    await relaySignalling([{ page: alice, name: 'alice' }, { page: bob, name: 'bob' }], 'alice');
    await join(alice);
    await join(bob);
    await expect(alice.locator('.room-top__state[data-state="connected"]')).toBeVisible({ timeout: 20_000 });
    await observeViewerFeedback(alice);
    await alice.getByRole('button', { name: /^share screen$/i }).click();
    const request = bob.getByRole('dialog', { name: /alice wants to share their screen/i });
    await expect(request).toBeVisible();
    await request.getByRole('button', { name: /^allow$/i }).click();
    await expect.poll(async () => {
      const current = await measure(alice, bob);
      return current.incoming.width === 1920 && current.incoming.height === 1080 && current.incoming.framesDecoded > 30;
    }, { timeout: 25_000 }).toBe(true);
    return { alice, bob, errors, close };
  } catch (error) {
    await close();
    throw error;
  }
}

type ControllerSample = Awaited<ReturnType<typeof measure>>;
const videoCap = (sample: ControllerSample) => sample.outgoing.parameters?.encodings[0].maxBitrate ?? 0;

async function sampleFor(sender: Page, receiver: Page, milliseconds: number) {
  const samples: ControllerSample[] = [];
  const until = Date.now() + milliseconds;
  do {
    samples.push(await measure(sender, receiver));
    await receiver.waitForTimeout(500);
  } while (Date.now() < until);
  return samples;
}

test('pausing the actual source and resuming does not collapse quality or resize capture', async ({ browser }, info) => {
  test.setTimeout(150_000);
  const peers = await startControllerSession(browser);
  const { alice, bob } = peers;
  const samples: Record<string, ControllerSample[]> = {};
  try {
    // Do not pause an unconfirmed trial: source-idle intentionally abandons
    // one to its proven base. Fifteen seconds with an unchanged cap exceeds
    // the 12s trial verdict window and avoids mistaking that reset for a bug.
    let priorCap = 0;
    let unchangedSince = Date.now();
    await expect.poll(async () => {
      const currentCap = videoCap(await measure(alice, bob));
      if (currentCap !== priorCap) {
        priorCap = currentCap;
        unchangedSince = Date.now();
      }
      return Date.now() - unchangedSince;
    }, { timeout: 60_000, intervals: [1_000] }).toBeGreaterThanOrEqual(15_000);
    const before = await measure(alice, bob);
    samples.beforePause = [before];
    const initialCap = videoCap(before);
    const initialConstraints = before.outgoing.capture!.constraints.length;
    expect(initialCap).toBeGreaterThanOrEqual(3_000_000);

    await alice.evaluate(() => { window.controllerCapture!.paused = true; });
    samples.paused = await sampleFor(alice, bob, 12_000);
    const paused = samples.paused.at(-1)!;
    expect(paused.outgoing.capture!.frames).toBe(samples.paused[0].outgoing.capture!.frames);
    // The media source really stopped producing frames; only the canvas draw
    // loop pauses, never the peer connection, stats hooks or receiver player.
    expect(paused.incoming.framesDecoded - samples.paused[0].incoming.framesDecoded).toBeLessThan(20);

    await alice.evaluate(() => { window.controllerCapture!.paused = false; });
    await expect.poll(async () => (await measure(alice, bob)).incoming.framesDecoded, { timeout: 6_000 })
      .toBeGreaterThan(paused.incoming.framesDecoded + 30);
    samples.resumed = await sampleFor(alice, bob, 6_000);
    const first = samples.resumed[0].incoming;
    const last = samples.resumed.at(-1)!.incoming;
    const fps = (last.framesDecoded - first.framesDecoded) / ((last.timestamp - first.timestamp) / 1000);
    expect(fps).toBeGreaterThanOrEqual(25);
    for (const sample of [...samples.paused, ...samples.resumed]) {
      expect(sample.outgoing.asked).toMatchObject({ width: 1920, height: 1080, fps: 30 });
      expect(videoCap(sample), 'intentional source pause is not congestion').toBeGreaterThanOrEqual(initialCap * 0.9);
      expect(sample.outgoing.capture!.constraints.length, 'pause/resume must not restart the capturer').toBe(initialConstraints);
      expect(sample.incoming).toMatchObject({ width: 1920, height: 1080, paused: false });
    }
    expect(peers.errors).toEqual([]);
  } finally {
    const path = info.outputPath('pause-resume-controller.json');
    await writeFile(path, JSON.stringify({ samples, errors: peers.errors }, null, 2));
    await info.attach('pause-resume-controller.json', { path, contentType: 'application/json' });
    await peers.close();
  }
});

/** Script only the two controller inputs implicated in the incident: a high
 * GCC estimate and intermittent receiver verdicts. Everything else, including
 * native encoding, decoding, RTP and DataChannel delivery, remains real.
 * Automatic receiver feedback is silenced for this test so a scheduled real
 * heartbeat cannot randomly overwrite a scripted verdict at a health tick.
 */
async function installFeedbackScenario(sender: Page, receiver: Page) {
  await sender.evaluate(async () => {
    const path = '/src/services/webrtcService.ts';
    const { webrtcService: service } = await import(/* @vite-ignore */ path) as { webrtcService: Service };
    const getStats = service.getStats.bind(service);
    service.getStats = async () => {
      const report = await getStats();
      if (!report) return report;
      const copied = new Map<string, RTCStats>();
      report.forEach((row, id) => copied.set(id, row.type === 'candidate-pair'
        ? { ...row, availableOutgoingBitrate: 30_000_000 }
        : row));
      return copied as RTCStatsReport;
    };
  });
  await receiver.evaluate(async () => {
    const path = '/src/services/transportService.ts';
    const { transportService } = await import(/* @vite-ignore */ path) as {
      transportService: { sendQualityFeedback: (...args: unknown[]) => Promise<void> };
    };
    transportService.sendQualityFeedback = async () => {};
  });
}

async function sendViewerVerdict(receiver: Page, level: 'poor' | 'excellent') {
  const sent = await receiver.evaluate(async (verdict) => {
    const path = '/src/services/dataChannelService.ts';
    const { dataChannelService } = await import(/* @vite-ignore */ path) as {
      dataChannelService: { send(message: unknown): boolean };
    };
    return dataChannelService.send({ t: 'quality', d: { feedback: {
      level: verdict, score: verdict === 'poor' ? 35 : 100,
      packetLossPercent: 0, jitterMs: 0, rttMs: 2,
      fps: verdict === 'poor' ? 8 : 30,
      viewport: { width: 1920, height: 1080 }, picture: { width: 1920, height: 1080 },
    } } });
  }, level);
  expect(sent, 'scripted verdict uses the open native DataChannel').toBe(true);
}

test('intermittent viewer warnings cannot repeatedly cut a stale report or immediately restore the high GCC ceiling', async ({ browser }, info) => {
  test.setTimeout(120_000);
  const peers = await startControllerSession(browser);
  const { alice, bob } = peers;
  const samples: Record<string, ControllerSample[]> = {};
  try {
    await installFeedbackScenario(alice, bob);
    await sendViewerVerdict(bob, 'excellent');
    // Three estimator polls clear the rolling median's pre-fixture values.
    await bob.waitForTimeout(10_000);
    const baseline = await measure(alice, bob);
    samples.baseline = [baseline];
    const baselineCap = videoCap(baseline);
    const initialConstraints = baseline.outgoing.capture!.constraints.length;

    await sendViewerVerdict(bob, 'poor');
    await expect.poll(async () => videoCap(await measure(alice, bob)), { timeout: 6_000 })
      .toBeLessThan(baselineCap * 0.98);
    const firstCut = videoCap(await measure(alice, bob));
    samples.sameWarning = await sampleFor(alice, bob, 6_000);
    for (const sample of samples.sameWarning) {
      expect(videoCap(sample), 'the same received warning is consumed once').toBe(firstCut);
    }

    await sendViewerVerdict(bob, 'excellent');
    samples.shortRecovery = await sampleFor(alice, bob, 6_000);
    for (const sample of samples.shortRecovery) {
      expect(videoCap(sample), 'one good report cannot bypass the healthy observation window').toBeLessThanOrEqual(firstCut + 25_000);
    }

    await sendViewerVerdict(bob, 'poor');
    await expect.poll(async () => videoCap(await measure(alice, bob)), { timeout: 6_000 })
      .toBeLessThan(firstCut * 0.98);
    const secondCut = videoCap(await measure(alice, bob));
    await sendViewerVerdict(bob, 'excellent');
    samples.secondShortRecovery = await sampleFor(alice, bob, 6_000);
    for (const sample of samples.secondShortRecovery) {
      expect(videoCap(sample), 'another brief good interval must not form a sawtooth').toBeLessThanOrEqual(secondCut + 25_000);
    }

    // Continuous healthy evidence may eventually earn one bounded trial. This
    // period ends before a trial can be confirmed and a second one can start.
    samples.sustainedRecovery = await sampleFor(alice, bob, 10_000);
    for (const sample of samples.sustainedRecovery) {
      expect(videoCap(sample), 'recovery is bounded, never a jump to the high estimate').toBeLessThanOrEqual(secondCut * 1.17 + 25_000);
    }
    const all = Object.values(samples).flat();
    for (const sample of all) {
      expect(sample.outgoing.capture!.constraints.length, 'bitrate feedback must not churn capture geometry').toBe(initialConstraints);
      expect(sample.incoming).toMatchObject({ width: 1920, height: 1080, paused: false });
    }
    expect(peers.errors).toEqual([]);
  } finally {
    const path = info.outputPath('intermittent-feedback-controller.json');
    await writeFile(path, JSON.stringify({ samples, errors: peers.errors }, null, 2));
    await info.attach('intermittent-feedback-controller.json', { path, contentType: 'application/json' });
    await peers.close();
  }
});
