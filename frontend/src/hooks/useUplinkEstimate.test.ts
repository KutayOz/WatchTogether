import { describe, expect, it } from 'vitest';
import { estimateFromBitrate, shouldClamp } from './useUplinkEstimate';
import { QUALITY_LADDER, QUALITY_PRESETS, type ScreenShareQuality } from '../types';

/**
 * The bitrate-to-presets decision.
 *
 * This replaces a speed test that measured the wrong path entirely — it asked
 * a Cloudflare edge a few milliseconds away how fast 256 KB arrived, and would
 * have unlocked every preset for everyone. So the thing worth pinning is that
 * a *slow* link is actually told it is slow, which is the case the old
 * implementation got backwards.
 */

// Imported, not restated. A local copy would keep passing while quietly not
// covering any rung added to the real ladder — the worst kind of green.
const LADDER = QUALITY_LADDER;

/** Bits per second a preset asks for, video and audio together. */
const cost = (q: ScreenShareQuality) =>
  QUALITY_PRESETS[q].video.bitrate + QUALITY_PRESETS[q].audio.bitrate;

describe('estimateFromBitrate', () => {
  it('offers nothing fixed on a link too slow for even the lowest preset', () => {
    // 1 Mbps against low's 1.6 Mbps.
    const estimate = estimateFromBitrate(1_000_000);

    expect(estimate.supportedQualities.low).toBe(false);
    // 'auto' rather than 'low': the encoder adapting downward is honest, where
    // recommending a preset the link cannot sustain is not.
    expect(estimate.recommendedQuality).toBe('auto');
  });

  it('recommends the best preset that fits, not the best that exists', () => {
    // 6 Mbps clears medium (4.1) with headroom but not high (8.3).
    const estimate = estimateFromBitrate(6_000_000);

    expect(estimate.recommendedQuality).toBe('medium');
    expect(estimate.supportedQualities.medium).toBe(true);
    expect(estimate.supportedQualities.high).toBe(false);
  });

  it('unlocks everything on a fast link', () => {
    const estimate = estimateFromBitrate(50_000_000);

    expect(estimate.recommendedQuality).toBe('extreme');
    for (const quality of LADDER) expect(estimate.supportedQualities[quality]).toBe(true);
  });

  /**
   * `auto` sets no ceiling and lets the encoder track the estimator itself, so
   * there is no bandwidth at which it stops being available — including the
   * bandwidth where it is the only thing left.
   */
  it('always keeps auto available', () => {
    for (const bps of [0, 100_000, 1_000_000, 100_000_000]) {
      expect(estimateFromBitrate(bps).supportedQualities.auto).toBe(true);
    }
  });

  /**
   * Every preset is judged against the same fraction of the estimate. Running
   * a link at its estimated ceiling buys queueing delay rather than
   * throughput, and the screen share is never the only thing on the wire.
   */
  it('leaves headroom rather than filling the estimate', () => {
    // Exactly medium's cost: it must NOT be offered, because that would mean
    // planning to use 100% of what the estimator saw.
    const estimate = estimateFromBitrate(cost('medium'));

    expect(estimate.supportedQualities.medium).toBe(false);
  });

  /**
   * A property rather than a case: more bandwidth must never take an option
   * away. An off-by-one in the ladder ordering would show up here and nowhere
   * else, because each individual case above would still pass.
   */
  it('never withdraws a preset as bandwidth increases', () => {
    let previous = estimateFromBitrate(0);

    for (let bps = 1_000_000; bps <= 60_000_000; bps += 1_000_000) {
      const current = estimateFromBitrate(bps);
      for (const quality of LADDER) {
        if (previous.supportedQualities[quality]) {
          expect(
            current.supportedQualities[quality],
            `${quality} was supported at a lower bitrate but not at ${bps}`,
          ).toBe(true);
        }
      }
      previous = current;
    }
  });

  it('reports the estimate in Mbps to one decimal', () => {
    expect(estimateFromBitrate(7_240_000).uplinkMbps).toBe(7.2);
    expect(estimateFromBitrate(1_596_000).uplinkMbps).toBe(1.6);
  });

  it('exposes an unrounded budget for the operating-point chooser', () => {
    // uplinkMbps is for display. Arithmetic that rounds to one decimal first
    // would quantise the budget into ~100 kbps steps.
    const estimate = estimateFromBitrate(2_345_678);
    expect(estimate.uplinkBps).toBe(2_345_678);
    expect(estimate.budgetBps).toBeLessThan(estimate.uplinkBps);
    expect(estimate.budgetBps).toBeGreaterThan(estimate.uplinkBps * 0.8);
  });
});

/**
 * The clamp is deliberately slacker than the selection, and that is a guard
 * against a feedback spiral rather than laxity.
 *
 * Chrome's availableOutgoingBitrate is bounded by what you are already sending.
 * Clamp down and the next estimate falls with you, which justifies clamping
 * again — the estimator ends up measuring the cage it is locked in, and a link
 * ratchets to the floor without ever having been that slow. This is the exact
 * mechanism that stranded users at the bottom preset.
 */
describe('shouldClamp', () => {
  it('does not clamp merely because we are self-limited', () => {
    // Sitting at 'low' (1.596 Mbps) and the estimator reports 1.7 — which is
    // roughly what it WOULD report, since it cannot see past our own ceiling.
    // Clamping here is how the spiral starts.
    expect(shouldClamp('low', 1_700_000)).toBe(false);
  });

  it('clamps when the current ask is flatly unaffordable', () => {
    expect(shouldClamp('medium', 2_000_000)).toBe(true);
  });

  it('treats no estimate as no opinion, never as slow', () => {
    // Firefox does not publish the statistic. Guessing would silently cap
    // quality for every user of a browser that simply declines to answer.
    expect(shouldClamp('extreme', null)).toBe(false);
  });
});
