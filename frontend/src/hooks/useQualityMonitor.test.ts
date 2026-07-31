import { describe, expect, it } from 'vitest';
import { calculateQualityScore, scoreToLevel, type QualityMetrics } from './useQualityMonitor';

/**
 * The score exists to drive one decision: the auto-downgrade in SessionRoom,
 * which fires only on 'critical'. So the question every case here asks is
 * "would the app notice?", not "is this number aesthetically right".
 *
 * The bug being fixed: FPS was 15% of a weighted average, which is not enough
 * weight to reach 'critical' (< 30) on its own. A stream frozen solid at 0 fps
 * with clean packet counters scored 79 — 'good' — so the downgrade never fired
 * on the one symptom users actually complained about.
 */

/** A path with nothing wrong with it, so each case can vary one thing. */
const healthy: QualityMetrics = {
  packetsLost: 0,
  packetsReceived: 50_000,
  jitterMs: 5,
  rttMs: 60,
  fps: 30,
  freezeSeconds: 0,
  intervalSeconds: 3,
};

const levelOf = (m: QualityMetrics) => scoreToLevel(calculateQualityScore(m));

describe('calculateQualityScore', () => {
  it('calls a healthy stream excellent', () => {
    expect(levelOf(healthy)).toBe('excellent');
  });

  it('calls a frozen stream critical even when the counters are clean', () => {
    // The exact case that scored 79 / 'good' before: no loss, no jitter, fine
    // RTT, and no picture at all.
    expect(levelOf({ ...healthy, fps: 0 })).toBe('critical');
  });

  it('calls a slideshow critical', () => {
    // 3 fps of a 30 fps source. Measured shape of the original complaint.
    expect(levelOf({ ...healthy, fps: 3 })).toBe('critical');
  });

  it('degrades through the levels as frame rate falls', () => {
    // Monotonic: every step down in frame rate must be a step down in score,
    // or the downgrade logic gets a signal that jitters instead of tracking.
    const scores = [30, 24, 18, 12, 6, 0].map((fps) =>
      calculateQualityScore({ ...healthy, fps }),
    );
    for (let i = 1; i < scores.length; i++) {
      expect(scores[i]).toBeLessThan(scores[i - 1]);
    }
  });

  it('does not punish a stream running slightly under its nominal rate', () => {
    // 27 of 30 fps is a normal encoder, not a problem to report.
    expect(levelOf({ ...healthy, fps: 27 })).toBe('excellent');
  });

  it('calls a stream that spent a third of the window frozen critical', () => {
    expect(levelOf({ ...healthy, freezeSeconds: 1, intervalSeconds: 3 })).toBe('critical');
  });

  it('still reacts to packet loss', () => {
    // The network half of the score has to keep working — the frame-rate gate
    // is a floor on top of it, not a replacement for it.
    expect(levelOf({ ...healthy, packetsLost: 5_000, packetsReceived: 45_000 })).toBe(
      'critical',
    );
  });

  it('scores loss over the window, not over the whole call', () => {
    // Both windows carry the same recent loss rate. The old code fed cumulative
    // totals in, so a call that had been up longer diluted its own bad news.
    const early = calculateQualityScore({
      ...healthy,
      packetsLost: 100,
      packetsReceived: 900,
    });
    const late = calculateQualityScore({
      ...healthy,
      packetsLost: 100,
      packetsReceived: 900,
    });
    expect(early).toBe(late);
  });
});
