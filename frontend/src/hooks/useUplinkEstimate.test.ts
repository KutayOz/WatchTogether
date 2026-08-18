import { describe, expect, it } from 'vitest';
import { budgetCeilingBps } from './operatingPoint';
import {
  OVER_ESTIMATE_MARGIN,
  estimateFromBitrate,
  isCapacityMeasurable,
  readUplinkSample,
  reconcileEstimate,
  shouldClamp,
  throughputBps,
  type UplinkSample,
} from './useUplinkEstimate';
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

    expect(estimate.withinEstimate.low).toBe(false);
    // 'auto' rather than 'low': the encoder adapting downward is honest, where
    // recommending a preset the link cannot sustain is not.
    expect(estimate.recommendedQuality).toBe('auto');
  });

  it('recommends the best preset that fits, not the best that exists', () => {
    // 6 Mbps clears medium (4.1) with headroom but not high (8.3).
    const estimate = estimateFromBitrate(6_000_000);

    expect(estimate.recommendedQuality).toBe('medium');
    expect(estimate.withinEstimate.medium).toBe(true);
    expect(estimate.withinEstimate.high).toBe(false);
  });

  it('unlocks everything on a fast link', () => {
    const estimate = estimateFromBitrate(50_000_000);

    expect(estimate.recommendedQuality).toBe('extreme');
    for (const quality of LADDER) expect(estimate.withinEstimate[quality]).toBe(true);
  });

  /**
   * `auto` sets no ceiling and lets the encoder track the estimator itself, so
   * there is no bandwidth at which it stops being available — including the
   * bandwidth where it is the only thing left.
   */
  it('always keeps auto available', () => {
    for (const bps of [0, 100_000, 1_000_000, 100_000_000]) {
      expect(estimateFromBitrate(bps).withinEstimate.auto).toBe(true);
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

    expect(estimate.withinEstimate.medium).toBe(false);
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
        if (previous.withinEstimate[quality]) {
          expect(
            current.withinEstimate[quality],
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

/**
 * Reading the link, and knowing when not to believe what it says.
 *
 * The session that motivated all of this ran over a TURN/TCP relay at 231 ms.
 * `availableOutgoingBitrate` there sat at ~30 kbps — within one BITRATE_STEP of
 * exactly what we were sending — on a link whose two ends had 200 Mbps and
 * 30 Mbps. The estimator was measuring our own ask, not the path.
 */
describe('reading the candidate pair', () => {
  function report(entries: Array<Record<string, unknown> & { id: string; type: string }>) {
    return new Map(entries.map((e) => [e.id, e])) as unknown as RTCStatsReport;
  }

  it('prefers the nominated pair and reads how it reaches the relay', () => {
    const sample = readUplinkSample(
      report([
        { id: 'L', type: 'local-candidate', relayProtocol: 'tcp' },
        {
          id: 'other',
          type: 'candidate-pair',
          state: 'succeeded',
          availableOutgoingBitrate: 9_000_000,
        },
        {
          id: 'live',
          type: 'candidate-pair',
          state: 'succeeded',
          nominated: true,
          availableOutgoingBitrate: 30_000,
          bytesSent: 500_000,
          localCandidateId: 'L',
        },
      ]),
      1000,
    );

    expect(sample).toMatchObject({ pairId: 'live', bps: 30_000, relayProtocol: 'tcp' });
  });

  it('has no opinion when the browser publishes none', () => {
    // Firefox. Null must mean "do not clamp", never "clamp to the lowest".
    expect(
      readUplinkSample(report([{ id: 'p', type: 'candidate-pair', state: 'succeeded' }]), 0),
    ).toBeNull();
  });

  it('does not trust a TCP or TLS relay to measure capacity', () => {
    const at = (relayProtocol?: string): UplinkSample => ({
      pairId: 'p',
      bps: 30_000,
      bytesSent: 0,
      relayProtocol,
      atMs: 0,
    });

    expect(isCapacityMeasurable(at('tcp'))).toBe(false);
    expect(isCapacityMeasurable(at('tls'))).toBe(false);
    expect(isCapacityMeasurable(at('udp'))).toBe(true);
    expect(isCapacityMeasurable(at(undefined))).toBe(true); // direct P2P
  });
});

describe('throughputBps', () => {
  const at = (pairId: string, bytesSent: number, atMs: number): UplinkSample => ({
    pairId,
    bps: 1_000_000,
    bytesSent,
    atMs,
  });

  it('needs two samples before it can say anything', () => {
    expect(throughputBps(null, at('p', 100, 0))).toBeNull();
  });

  it('measures the delta as bits per second', () => {
    // 125 000 bytes in 1 s = 1 Mbps.
    expect(throughputBps(at('p', 0, 0), at('p', 125_000, 1000))).toBe(1_000_000);
  });

  it('refuses to difference across a candidate-pair change', () => {
    // bytesSent restarts per pair. Without this guard an ICE switch invents an
    // enormous throughput spike out of a counter reset.
    expect(throughputBps(at('old', 5_000_000, 0), at('new', 1_000, 1000))).toBeNull();
  });
});

describe('reconcileEstimate', () => {
  it('replaces a TCP-relay estimate with what we actually sent', () => {
    // The reported failure, verbatim: estimate pinned at 30 kbps while we were
    // demonstrably pushing ~100 kbps of bytes through the relay.
    expect(reconcileEstimate(30_000, 100_000, false)).toEqual({
      bps: 100_000,
      capacityKnown: false,
    });
  });

  it('believes the estimate when nothing contradicts it', () => {
    expect(reconcileEstimate(3_000_000, 2_500_000, true)).toEqual({
      bps: 3_000_000,
      capacityKnown: true,
    });
  });

  it('disbelieves an estimate the wire has already beaten', () => {
    // Only one of "you cannot send 1 Mbps" and "we just sent 2 Mbps" is true.
    const observed = 1_000_000 * OVER_ESTIMATE_MARGIN + 1;
    expect(reconcileEstimate(1_000_000, observed, true)).toEqual({
      bps: observed,
      capacityKnown: false,
    });
  });

  it('tolerates framing overhead without calling the estimate wrong', () => {
    // bytesSent counts STUN, RTCP and TURN framing alongside media.
    expect(reconcileEstimate(1_000_000, 1_050_000, true).capacityKnown).toBe(true);
  });

  it('holds no opinion when it has neither number', () => {
    expect(reconcileEstimate(null, null, true).bps).toBeNull();
  });
});

describe('advice from an untrusted number', () => {
  it('never disables a preset it cannot honestly rule out', () => {
    // The regression that stranded the user. A 30 kbps TCP-relay reading greyed
    // out all five fixed presets (MediaControls: disabled={!isSupported}), so
    // the collapse removed the only manual escape from itself.
    const bogus = estimateFromBitrate(30_000, false);
    for (const key of Object.keys(bogus.withinEstimate) as ScreenShareQuality[]) {
      expect(bogus.withinEstimate[key]).toBe(true);
    }
    expect(bogus.recommendedQuality).toBe('auto');
    expect(bogus.capacityKnown).toBe(false);
  });

  it('still says a slow link is slow when it actually measured one', () => {
    const measured = estimateFromBitrate(30_000, true);
    expect(measured.withinEstimate.low).toBe(false);
    expect(measured.withinEstimate.auto).toBe(true);
  });
});

describe('withinEstimate is advice, not a lock', () => {
  it('cannot clear the top presets from anything auto is able to send', () => {
    // The arithmetic that made the old `disabled={!isSupported}` a trap at the
    // top end. `availableOutgoingBitrate` cannot exceed what we send, `auto`
    // bounds what we send, so the estimate on `auto` tops out at its own cap —
    // and `high` needs 9.6 Mbps of estimate to clear. The ceiling bounded the
    // measurement that would have raised the ceiling, so a 60 Mbps uplink saw
    // High, Ultra and Extreme greyed out and had no way to reach them.
    const mostAutoCanSend = budgetCeilingBps('auto', 24, null);
    const estimate = estimateFromBitrate(mostAutoCanSend);

    expect(estimate.withinEstimate.high).toBe(false);
    expect(estimate.withinEstimate.ultra).toBe(false);
    expect(estimate.withinEstimate.extreme).toBe(false);
  });
});
