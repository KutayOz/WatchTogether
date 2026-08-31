import { describe, expect, it } from 'vitest';
import {
  PRINTED_SAMPLES,
  formatDiagnosticsReport,
  type DiagnosticsHeader,
  type DiagnosticsSnapshot,
} from './diagnosticsReport';

/**
 * The report is the thing a person pastes into a bug report, so its shape is a
 * test rather than a screenshot — the same reason formatIceDiagnostics is pure.
 *
 * What it has to survive: a browser that publishes half the statistics, a
 * sample taken before anything has been measured, and a session long enough to
 * overflow the window. In every one of those the report must still be readable
 * and must not claim more than it knows.
 */

const header: DiagnosticsHeader = {
  generatedAt: '2026-08-19T20:00:00.000Z',
  sessionId: 'abc123',
  role: 'sharer',
  userAgent: 'Mozilla/5.0 Chrome/141',
  devicePixelRatio: 2,
  quality: 'auto',
  contentMode: 'film',
  codec: 'vp9',
  viewport: { width: 2400, height: 1350 },
};

/** A sample with nothing measured, so each case states only what it varies. */
function sample(over: Partial<DiagnosticsSnapshot> = {}): DiagnosticsSnapshot {
  return {
    atMs: 0,
    path: null,
    uplink: null,
    point: null,
    outbound: null,
    bpp: null,
    senderHealth: 'unknown',
    budgetBps: null,
    probing: false,
    capacityPixelsPerSecond: null,
    inbound: null,
    level: null,
    score: null,
    lossPercent: null,
    viewerLevel: null,
    viewerViewport: null,
    viewerPicture: null,
    viewerStarved: false,
    peerShare: null,
    ...over,
  };
}

/** The failure this whole change is about: a CPU-bound software VP9 encode. */
const cpuBound = sample({
  atMs: 9_000,
  path: {
    isRelayed: false,
    protocol: 'udp',
    local: 'srflx',
    remote: 'srflx',
    rttMs: 24,
  },
  point: { width: 1920, height: 1080, fps: 24, videoBps: 2_475_000, audioBps: 96_000, bpp: 0.0497 },
  outbound: {
    frameWidth: 1280,
    frameHeight: 720,
    framesPerSecond: 7,
    targetBitrate: 2_400_000,
    qualityLimitationReason: 'cpu',
    encoderImplementation: 'libvpx-vp9',
    totalEncodeTime: 42,
    framesEncoded: 900,
  },
  bpp: 0.372,
  senderHealth: 'cpu-bound',
  budgetBps: 2_571_000,
  capacityPixelsPerSecond: 37_324_800,
  viewerLevel: 'poor',
  viewerViewport: { width: 2400, height: 1350 },
});

describe('formatDiagnosticsReport', () => {
  it('leads with what the sender asked for beside what it achieved', () => {
    // The pair is the whole diagnosis. A collapsed frame rate INFLATES bpp, so
    // `1280x720 @ 7 · 0.372 bpp` reads as excellent quality on its own.
    const text = formatDiagnosticsReport({ header, samples: [cpuBound], logs: [], ice: null });
    expect(text).toContain('asked       1920x1080@24');
    expect(text).toContain('sending     1280x720@7');
    expect(text).toContain('limited by cpu');
    expect(text).toContain('libvpx-vp9');
  });

  it('names the transport, because it is the other candidate for this symptom', () => {
    const relayed = sample({
      path: {
        isRelayed: true,
        protocol: 'udp',
        relayProtocol: 'tcp',
        local: 'relay',
        remote: 'srflx',
        rttMs: 231,
      },
    });
    const text = formatDiagnosticsReport({ header, samples: [relayed], logs: [], ice: null });
    expect(text).toContain('turn/tcp');
    expect(text).toContain('231 ms rtt');
  });

  it('shows the receiver its own freezes', () => {
    // The one symptom no diagnostic in this app reported, on the one end that
    // can see it.
    const viewing = sample({
      inbound: {
        frameWidth: 1920,
        frameHeight: 1080,
        framesPerSecond: 7,
        freezeCount: 14,
        totalFreezesDuration: 22.4,
        framesReceived: 900,
        framesDecoded: 860,
        framesDropped: 41,
        jitterBufferDelay: 93,
        jitterBufferEmittedCount: 300,
        pliCount: 6,
        nackCount: 128,
        decoderImplementation: 'libvpx-vp9',
      },
      level: 'poor',
      score: 42,
    });
    const text = formatDiagnosticsReport({ header, samples: [viewing], logs: [], ice: null });
    expect(text).toContain('what this machine received');
    expect(text).toContain('14 freezes (22.4s)');
    expect(text).toContain('buffer 310ms');
  });

  it('omits a table nobody has data for rather than printing a wall of dashes', () => {
    const text = formatDiagnosticsReport({ header, samples: [cpuBound], logs: [], ice: null });
    expect(text).toContain('what this machine sent');
    expect(text).not.toContain('what this machine received');
  });

  it('survives a browser that publishes almost nothing', () => {
    // Firefox and Safari. A report that throws here is worth less than one that
    // says "—" a lot.
    const text = formatDiagnosticsReport({ header, samples: [sample()], logs: [], ice: null });
    expect(text).toContain('WatchTogether debug report');
    expect(text).toContain('health      unknown');
  });

  it('says so when there is nothing recorded yet', () => {
    const text = formatDiagnosticsReport({ header, samples: [], logs: [], ice: null });
    expect(text).toContain('no samples recorded');
  });

  it('says how many samples it did not print', () => {
    // A silent truncation reads as "that is all there was", which is the one
    // thing a diagnostic must never imply.
    const many = Array.from({ length: PRINTED_SAMPLES + 7 }, (_, i) =>
      sample({ atMs: i * 3000, senderHealth: 'satisfied', point: cpuBound.point }),
    );
    const text = formatDiagnosticsReport({ header, samples: many, logs: [], ice: null });
    expect(text).toContain('(7 older samples held but not printed)');
  });

  it('stamps the timeline relative to its end, so the last row is 0s', () => {
    const walk = [
      sample({ atMs: 0, point: cpuBound.point }),
      sample({ atMs: 3000, point: cpuBound.point }),
      sample({ atMs: 6000, point: cpuBound.point }),
    ];
    const text = formatDiagnosticsReport({ header, samples: walk, logs: [], ice: null });
    expect(text).toContain('-6s');
    expect(text).toContain('0s ');
  });

  it('marks a sample taken while a probe was in flight', () => {
    // Otherwise a one-window dip looks like a collapse rather than the cost of
    // finding out whether the link had more.
    const text = formatDiagnosticsReport({
      header,
      samples: [sample({ point: cpuBound.point, senderHealth: 'satisfied', probing: true })],
      logs: [],
      ice: null,
    });
    expect(text).toContain('satisfied*');
  });

  it('carries the log lines and the ice tables through', () => {
    const text = formatDiagnosticsReport({
      header,
      samples: [cpuBound],
      logs: [{ at: 0, level: 'warn', text: '[WebRTC] falling back to H.264' }],
      ice: 'ICE connected / gathering complete',
    });
    expect(text).toContain('warn [WebRTC] falling back to H.264');
    expect(text).toContain('ICE connected');
  });
});


/**
 * The line that was true and unhelpful.
 *
 * `they say excellent` was the whole of what the report knew about the far end,
 * and it was the single most misleading line in it: the receiver's score has no
 * resolution term, so a picture collapsed to a stamp reports perfect health.
 * The deficit has to be printed beside the verdict or the next reader draws the
 * same wrong conclusion.
 */
describe('the viewer readout', () => {
  it('prints the picture beside the room it is drawn in', () => {
    const report = formatDiagnosticsReport({
      header,
      samples: [
        sample({
          viewerLevel: 'excellent',
          viewerViewport: { width: 2386, height: 1358 },
          viewerPicture: { width: 300, height: 158 },
          viewerStarved: true,
        }),
      ],
      logs: [],
      ice: null,
    });
    expect(report).toContain('drawing it at 2386x1358');
    expect(report).toContain('getting 300x158');
    expect(report).toContain('STARVED');
  });

  it('says nothing about a deficit it cannot measure', () => {
    const report = formatDiagnosticsReport({
      header,
      samples: [sample({ viewerLevel: 'good', viewerViewport: { width: 1920, height: 1080 } })],
      logs: [],
      ice: null,
    });
    expect(report).toContain('drawing it at 1920x1080');
    expect(report).not.toContain('getting');
    expect(report).not.toContain('STARVED');
  });
});
