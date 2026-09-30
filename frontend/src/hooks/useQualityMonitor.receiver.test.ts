import { act, createElement, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { webrtcService } from '../services/webrtcService';
import { useQualityMonitor } from './useQualityMonitor';
import type { QualityFeedback } from '../types';

vi.mock('../services/webrtcService', () => ({ webrtcService: { getStats: vi.fn() } }));

type VideoReport = {
  id: string;
  timestamp: number;
  type: string;
  kind: string;
  trackIdentifier?: string;
  ssrc: number;
  bytesReceived: number;
  packetsReceived: number;
  packetsLost: number;
  framesDecoded?: number;
  framesPerSecond?: number;
  frameWidth: number;
  frameHeight: number;
  totalFreezesDuration: number;
  transportId: string;
};

function video(overrides: Partial<VideoReport> = {}): VideoReport {
  return {
    id: 'inbound-screen', timestamp: 0, type: 'inbound-rtp', kind: 'video',
    trackIdentifier: 'screen', ssrc: 111, bytesReceived: 100_000, packetsReceived: 100,
    packetsLost: 0, framesDecoded: 0, framesPerSecond: 24, frameWidth: 1920,
    frameHeight: 1080, totalFreezesDuration: 0, transportId: 'transport', ...overrides,
  };
}

function report(...entries: Array<{ id: string; [key: string]: unknown }>): RTCStatsReport {
  return new Map(entries.map((entry) => [entry.id, entry])) as unknown as RTCStatsReport;
}

let root: Root;
let state: ReturnType<typeof useQualityMonitor>;
let currentReport: RTCStatsReport;
const getStats = vi.mocked(webrtcService.getStats);
let currentProps: {
  active: boolean;
  onFeedback?: (value: QualityFeedback) => void;
  expectedFps?: number;
  trackId?: string;
};

function Probe() {
  const result = useQualityMonitor(currentProps.active, currentProps.onFeedback,
    currentProps.expectedFps, currentProps.trackId);
  useEffect(() => { state = result; }, [result]);
  return null;
}

async function render(overrides: Partial<typeof currentProps> = {}) {
  currentProps = { ...currentProps, ...overrides };
  await act(async () => { root.render(createElement(Probe)); });
}

async function tick(next: RTCStatsReport) {
  currentReport = next;
  await act(async () => { await vi.advanceTimersByTimeAsync(3000); });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  getStats.mockReset();
  getStats.mockImplementation(async () => currentReport);
  currentReport = report(video());
  currentProps = { active: true, expectedFps: 24, trackId: 'screen', onFeedback: vi.fn() };
  const container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  await act(async () => { root.unmount(); });
  document.body.innerHTML = '';
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('receiver quality sampling', () => {
  it('reports a completely stalled screen even while the camera carries traffic', async () => {
    const camera = video({ id: 'camera', trackIdentifier: 'camera', ssrc: 222,
      frameWidth: 640, frameHeight: 480, framesPerSecond: 30 });
    currentReport = report(video(), camera);
    await render();
    expect(state.quality).toBeNull();
    await tick(report(video({ timestamp: 3000, framesPerSecond: 0 }), {
      ...camera, timestamp: 3000, bytesReceived: 2_000_000, framesDecoded: 90,
    }));
    expect(state.quality).toBe('critical');
    expect(state.metrics?.fps).toBe(0);
    expect(currentProps.onFeedback).toHaveBeenCalledWith(expect.objectContaining({
      level: 'critical', picture: { width: 1920, height: 1080 },
    }));
  });

  it('keeps a paused source healthy despite no traffic and browser freeze counters', async () => {
    await render({ expectedFps: 0 });
    await tick(report(video({ timestamp: 3000, framesPerSecond: 0, totalFreezesDuration: 3 })));
    expect(state.quality).toBe('excellent');
    await render({ expectedFps: 24 });
    await tick(report(video({ timestamp: 6000, bytesReceived: 2_000_000,
      packetsReceived: 2000, framesDecoded: 72, totalFreezesDuration: 6 })));
    expect(state.quality).toBe('excellent');
  });

  it('does not report a partial pause/resume window as network starvation', async () => {
    await render({ expectedFps: 0 });
    await render({ expectedFps: 24 });
    await tick(report(video({ timestamp: 3000, bytesReceived: 1_000_000,
      packetsReceived: 1000, framesDecoded: 24, totalFreezesDuration: 2 })));
    expect(state.quality).toBe('excellent');
    // Grace ends with the mixed interval; a genuine subsequent stall still
    // reports critical when packet loss and RTT are both clean.
    await tick(report(video({ timestamp: 6000, bytesReceived: 1_000_000,
      packetsReceived: 1000, framesDecoded: 24, totalFreezesDuration: 5 })));
    expect(state.quality).toBe('critical');
  });

  it('remembers a pause and resume occurring between receiver polls', async () => {
    await render();
    await tick(report(video({ timestamp: 3000, bytesReceived: 2_000_000,
      packetsReceived: 2000, framesDecoded: 72 })));
    await render({ expectedFps: 0 });
    await render({ expectedFps: 24 });
    await tick(report(video({ timestamp: 6000, bytesReceived: 3_000_000,
      packetsReceived: 3000, framesDecoded: 96, totalFreezesDuration: 2 })));
    expect(state.quality).toBe('excellent');
    expect(state.metrics?.fps).toBe(8);
    await tick(report(video({ timestamp: 9000, bytesReceived: 5_000_000,
      packetsReceived: 5000, framesDecoded: 168, totalFreezesDuration: 2 })));
    expect(state.quality).toBe('excellent');
  });

  it('does not punish occasional still-frame updates that straddle polling windows', async () => {
    await render({ expectedFps: 1 });
    await tick(report(video({ timestamp: 3000, framesPerSecond: 0, totalFreezesDuration: 3 })));
    expect(state.quality).toBe('excellent');
  });

  it('derives interval FPS when browsers omit framesPerSecond', async () => {
    currentReport = report(video({ framesPerSecond: undefined, framesDecoded: 100 }));
    await render();
    await tick(report(video({ timestamp: 3000, bytesReceived: 2_000_000,
      framesPerSecond: undefined, framesDecoded: 172, packetsReceived: 2000 })));
    expect(state.quality).toBe('excellent');
    expect(state.metrics?.fps).toBe(24);
    expect(state.inbound?.framesPerSecond).toBe(24);
  });

  it('does not invent a decoder failure when all frame-rate counters are unavailable', async () => {
    currentReport = report(video({ framesPerSecond: undefined, framesDecoded: undefined }));
    await render();
    await tick(report(video({ timestamp: 3000, bytesReceived: 2_000_000,
      framesPerSecond: undefined, framesDecoded: undefined, packetsReceived: 2000 })));
    expect(state.quality).toBe('excellent');
  });

  it('still detects measured freezes when frame-rate statistics are unavailable', async () => {
    currentReport = report(video({ framesPerSecond: undefined, framesDecoded: undefined }));
    await render();
    await tick(report(video({ timestamp: 3000, bytesReceived: 2_000_000,
      framesPerSecond: undefined, framesDecoded: undefined, packetsReceived: 2000,
      totalFreezesDuration: 1 })));
    expect(state.quality).toBe('critical');
  });

  it('re-seeds reset counters instead of emitting a false failure after reconnect', async () => {
    currentReport = report(video({ framesDecoded: 1000, bytesReceived: 2_000_000,
      packetsReceived: 2000 }));
    await render();
    await tick(report(video({ timestamp: 3000, framesDecoded: 0, framesPerSecond: 0 })));
    expect(state.quality).toBeNull();
    expect(currentProps.onFeedback).not.toHaveBeenCalled();
    await tick(report(video({ timestamp: 6000, framesDecoded: 72,
      bytesReceived: 2_000_000, packetsReceived: 2000 })));
    expect(state.quality).toBe('excellent');
  });

  it('does not difference across a new stats identity with a reused SSRC', async () => {
    await render();
    await tick(report(video({ id: 'replacement', timestamp: 3000, framesDecoded: 72,
      bytesReceived: 2_000_000, packetsReceived: 2000 })));
    expect(state.quality).toBeNull();
    expect(currentProps.onFeedback).not.toHaveBeenCalled();
  });

  it('uses the selected media transport RTT, not the last successful candidate', async () => {
    await render();
    const entries = [
      video({ timestamp: 3000, framesDecoded: 72, bytesReceived: 2_000_000, packetsReceived: 2000 }),
      { id: 'transport', type: 'transport', selectedCandidatePairId: 'selected-pair' },
      { id: 'selected-pair', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.025 },
      { id: 'unused-pair', type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.9 },
    ];
    await tick(report(...entries));
    expect(state.metrics?.rttMs).toBe(25);
    expect(state.quality).toBe('excellent');
  });

  it('does not replace an absent screen with camera statistics', async () => {
    currentReport = report(video({ trackIdentifier: 'camera' }));
    await render();
    await tick(report(video({ timestamp: 3000, trackIdentifier: 'camera', framesDecoded: 72 })));
    expect(state.quality).toBeNull();
    expect(state.inbound).toBeNull();
    expect(currentProps.onFeedback).not.toHaveBeenCalled();
  });

  it('keeps the largest stream selected on browsers without track identifiers', async () => {
    const screen = video({ trackIdentifier: undefined });
    const camera = video({ id: 'camera', ssrc: 222, trackIdentifier: undefined,
      frameWidth: 640, frameHeight: 480 });
    currentReport = report(screen, camera);
    await render();
    await tick(report({ ...screen, timestamp: 3000, framesPerSecond: 0 }, {
      ...camera, timestamp: 3000, bytesReceived: 2_000_000, framesDecoded: 72,
    }));
    expect(state.inbound?.frameHeight).toBe(1080);
    expect(state.quality).toBe('critical');
  });

  it('scores recent packet loss without retaining old loss in the next interval', async () => {
    await render();
    await tick(report(video({ timestamp: 3000, framesDecoded: 72, packetsLost: 50,
      packetsReceived: 1050, bytesReceived: 2_000_000 })));
    expect(state.quality).toBe('critical');
    await tick(report(video({ timestamp: 6000, framesDecoded: 144, packetsLost: 50,
      packetsReceived: 2050, bytesReceived: 4_000_000 })));
    expect(state.quality).toBe('excellent');
    expect(state.metrics?.packetsLost).toBe(0);
  });

  it('repeats unchanged feedback and changes callbacks without resetting sampling', async () => {
    await render();
    for (let index = 1; index <= 3; index++) {
      await tick(report(video({ timestamp: index * 3000, framesDecoded: index * 72,
        packetsReceived: index * 2000, bytesReceived: index * 2_000_000 })));
    }
    expect(currentProps.onFeedback).toHaveBeenCalledTimes(1);
    const replacement = vi.fn();
    const calls = getStats.mock.calls.length;
    await render({ onFeedback: replacement });
    expect(getStats).toHaveBeenCalledTimes(calls);
    await tick(report(video({ timestamp: 12000, framesDecoded: 288,
      packetsReceived: 8000, bytesReceived: 8_000_000 })));
    expect(replacement).toHaveBeenCalledTimes(1);
  });

  it('invalidates pending stats when watching stops', async () => {
    let resolve!: (value: RTCStatsReport) => void;
    getStats.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await render({ active: false });
    await act(async () => { resolve(report(video())); });
    expect(state.inbound).toBeNull();
    expect(state.quality).toBeNull();
    expect(currentProps.onFeedback).not.toHaveBeenCalled();
  });

  it('never overlaps slow polls', async () => {
    let resolve!: (value: RTCStatsReport) => void;
    getStats.mockImplementationOnce(() => new Promise((done) => { resolve = done; }));
    await render();
    await tick(report(video()));
    await tick(report(video()));
    expect(getStats).toHaveBeenCalledTimes(1);
    await act(async () => { resolve(report(video({ timestamp: 6000 }))); });
    await tick(report(video({ timestamp: 9000, framesDecoded: 72,
      bytesReceived: 2_000_000, packetsReceived: 2000 })));
    expect(getStats).toHaveBeenCalledTimes(2);
    expect(state.quality).toBe('excellent');
  });
});
