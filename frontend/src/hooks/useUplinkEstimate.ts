import { useEffect, useState } from 'react';
import { webrtcService } from '../services/webrtcService';
import {
  QUALITY_LADDER,
  QUALITY_PRESETS,
  type ScreenShareQuality,
  type UplinkEstimate,
} from '../types';

/**
 * How much uplink the browser thinks it has, read off the peer connection.
 *
 * Replaces the speed test, which POSTed 256 KB to the API every five minutes
 * and asked how fast it arrived. That question stopped being useful the moment
 * the backend moved to Cloudflare: a Worker answers from the nearest edge, a
 * few milliseconds away, so the measurement described the path to Cloudflare
 * and not the path to the person you are actually streaming to. It would have
 * reported an enormous uplink for everybody and unlocked every preset — worst
 * for exactly the users whose links cannot carry them.
 *
 * `availableOutgoingBitrate` is the bandwidth estimator's own view of the real
 * path, updated continuously from what the connection is actually achieving.
 * It costs no requests, no CPU and no round trips, because the connection is
 * already computing it.
 */

const POLL_INTERVAL_MS = 3000;

/**
 * Samples kept for the median. Six samples at 3 s is roughly the last twenty
 * seconds — long enough that one bad estimate cannot drop someone's quality,
 * short enough to react before a struggling link has been stuttering for a
 * minute.
 */
const WINDOW = 6;

/**
 * How many samples before we will say anything at all.
 *
 * Was WINDOW (six samples, eighteen seconds) because this value used to DRIVE
 * the clamp, and acting on the estimator's wild opening readings would drop
 * quality at the exact moment a call starts. The control input is now sender
 * health (useSenderHealth), so this number only gates advice — and a median of
 * three is still outlier-robust. Nine seconds to a first opinion instead of
 * eighteen.
 */
const MIN_SAMPLES = 3;

/**
 * Fraction of the estimate a stream is allowed to claim.
 *
 * Not 1.0, for two reasons: running a link at its estimated ceiling is how you
 * get queueing delay rather than throughput, and the screen share is never the
 * only thing on the wire — camera video, audio and the data channel are all
 * sharing it.
 */
export const HEADROOM_SELECT = 0.85;

/**
 * Headroom for the *clamp*, as opposed to the selection above.
 *
 * 1.0 deliberately. This is the guard against a feedback spiral that the old
 * single-headroom design walked straight into: Chrome's
 * `availableOutgoingBitrate` is bounded by what you are already sending, so
 * clamping down lowers the next estimate, which justifies clamping again. The
 * estimator ends up measuring the cage it is locked in, and a link ratchets to
 * the floor without ever having been that slow.
 *
 * At 1.0 the clamp only fires when the estimator says you cannot afford what
 * you are ALREADY asking for — a statement that cannot be manufactured by your
 * own restraint.
 */
export const HEADROOM_CLAMP = 1.0;

/**
 * How much the observed throughput may exceed the estimate before we call the
 * estimate wrong rather than merely noisy.
 *
 * `bytesSent` on a candidate pair counts STUN keepalives, RTCP and TURN framing
 * alongside media, so observed legitimately runs a few percent over what the
 * pacer was targeting. 25% is clear of that margin: past it, we are putting
 * more on the wire than the estimator says the wire can take, and only one of
 * those two numbers can be right.
 */
export const OVER_ESTIMATE_MARGIN = 1.25;

/** Total bits per second a preset asks for, video and audio together. */
function presetBitrate(quality: ScreenShareQuality): number {
  const preset = QUALITY_PRESETS[quality];
  return preset.video.bitrate + preset.audio.bitrate;
}

/**
 * Turn a bitrate estimate into "which presets fit".
 *
 * Exported because this is the part with the judgement in it, and a pure
 * function of one number is worth testing directly rather than through a
 * polling hook.
 *
 * @param capacityKnown False when `bitsPerSecond` is a measured lower bound
 *                      rather than a capacity estimate — see UplinkEstimate.
 */
export function estimateFromBitrate(
  bitsPerSecond: number,
  capacityKnown = true,
  observedBps: number | null = null,
): UplinkEstimate {
  const budget = bitsPerSecond * HEADROOM_SELECT;
  const withinEstimate = {} as Record<ScreenShareQuality, boolean>;

  for (const key of Object.keys(QUALITY_PRESETS) as ScreenShareQuality[]) {
    // `auto` sets no fixed ceiling of its own, so it fits by definition — and
    // it is the honest answer on a link too slow for even the lowest preset.
    //
    // When capacity is unknown the number in hand is a lower bound, so it can
    // say a preset fits but never that one does not.
    withinEstimate[key] = key === 'auto' || !capacityKnown || presetBitrate(key) <= budget;
  }

  // The best fixed preset the link has actually shown it can fill. QUALITY_LADDER
  // carries the ordering, because "cheapest first" is a property of the ladder
  // and not of the object literal's declaration order — and duplicating it here
  // is how a new rung ends up silently uncovered.
  const affordable = QUALITY_LADDER.filter((key) => withinEstimate[key]);

  return {
    uplinkMbps: Math.round((bitsPerSecond / 1_000_000) * 10) / 10,
    uplinkBps: bitsPerSecond,
    budgetBps: budget,
    // Nothing fixed fits: hand back `auto` so the encoder adapts downward
    // instead of the UI recommending a preset that cannot be sustained. With
    // capacity unknown there is nothing to recommend FROM, so `auto` again.
    recommendedQuality: capacityKnown ? (affordable.at(-1) ?? 'auto') : 'auto',
    withinEstimate,
    observedBps,
    capacityKnown,
  };
}

/** Middle value, so one outlier in either direction cannot move the result. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

interface CandidatePairStats {
  id?: string;
  state?: string;
  nominated?: boolean;
  availableOutgoingBitrate?: number;
  bytesSent?: number;
  localCandidateId?: string;
}

/** One reading of the active candidate pair. */
export interface UplinkSample {
  /** Pair identity. `bytesSent` restarts per pair, so deltas must not cross one. */
  pairId: string;
  bps: number | null;
  bytesSent: number | null;
  /** How we reach the TURN server, when relayed: udp | tcp | tls. */
  relayProtocol?: string;
  atMs: number;
}

/**
 * Pull one sample off the active candidate pair.
 *
 * Missing capacity estimates stay null; byte counters can still provide a
 * measured throughput lower bound. The selected ICE pair owns both counters.
 */
export function readUplinkSample(stats: RTCStatsReport, atMs: number): UplinkSample | null {
  let selectedPairId: string | null = null;
  stats.forEach((report) => {
    if (report.type === 'transport' && typeof report.selectedCandidatePairId === 'string') {
      selectedPairId = report.selectedCandidatePairId;
    }
  });

  let found: (RTCStats & CandidatePairStats) | null = null;
  stats.forEach((report) => {
    if (report.type !== 'candidate-pair' || report.state !== 'succeeded') return;
    const pair = report as RTCStats & CandidatePairStats;
    // A nominated pair can remain in the report after ICE switches paths.
    // The transport's selected ID is authoritative when the browser supplies it.
    if (selectedPairId !== null) {
      if (pair.id === selectedPairId) found = pair;
      return;
    }
    if (found === null || (!found.nominated && pair.nominated)) found = pair;
  });
  if (found === null) return null;
  const pair = found as RTCStats & CandidatePairStats;
  const local = pair.localCandidateId
    ? (stats.get(pair.localCandidateId) as (RTCStats & { relayProtocol?: string }) | undefined)
    : undefined;
  return {
    pairId: pair.id,
    bps: finiteNonnegative(pair.availableOutgoingBitrate),
    bytesSent: finiteNonnegative(pair.bytesSent),
    relayProtocol: local?.relayProtocol,
    atMs,
  };
}

function finiteNonnegative(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * Is this path's `availableOutgoingBitrate` a statement about CAPACITY?
 *
 * Not on a TURN/TCP or TURN/TLS relay. Chrome's congestion controller infers
 * available bandwidth from inter-arrival delay gradients, which assumes the
 * transport underneath does nothing of its own. TCP does a great deal: it
 * retransmits, it holds the line head-of-line while it does, and it runs its
 * own congestion control. Every one of those shows up as delay that has nothing
 * to do with how much the path can carry, and the estimate collapses.
 *
 * The corroborating tell from the session that motivated this: the estimate sat
 * at ~30 kbps, within one BITRATE_STEP of exactly what we were sending. A
 * number that tracks your own ask that closely is measuring the ask.
 */
export function isCapacityMeasurable(sample: UplinkSample): boolean {
  return sample.relayProtocol !== 'tcp' && sample.relayProtocol !== 'tls';
}

/**
 * Bits per second actually put on the wire between two samples.
 *
 * Null on the first sample, and null across a pair change: `bytesSent` is
 * per-candidate-pair and restarts at zero, so an ICE switch would otherwise
 * manufacture an enormous spike out of a counter reset.
 */
export function throughputBps(prev: UplinkSample | null, next: UplinkSample): number | null {
  if (!prev) return null;
  if (prev.pairId !== next.pairId) return null;
  if (prev.bytesSent === null || next.bytesSent === null) return null;
  const seconds = (next.atMs - prev.atMs) / 1000;
  if (seconds <= 0) return null;
  const bytes = next.bytesSent - prev.bytesSent;
  if (bytes < 0) return null; // counter reset we did not catch
  return (bytes * 8) / seconds;
}

/**
 * Reconcile what the estimator claims against what we actually sent.
 *
 * Two ways the estimate loses. It can be untrustworthy by construction (a TCP
 * relay), or it can be contradicted by evidence — we are demonstrably pushing
 * more than it says is possible. In both cases the honest answer is the
 * observed throughput, labelled as the lower bound it is.
 *
 * This is what turns a collapse into a decrease. On a 2 Mbps budget whose
 * estimate drops to 300 kbps, the old path computed `min(previous, 255k)` — a
 * sevenfold cut in one step. Corroborated against ~2 Mbps of bytes actually
 * sent, the same step trims about 15%.
 */
export function reconcileEstimate(
  estimateBps: number | null,
  observedBps: number | null,
  capacityMeasurable: boolean,
): { bps: number | null; capacityKnown: boolean } {
  estimateBps = finiteNonnegative(estimateBps);
  observedBps = finiteNonnegative(observedBps);
  if (!capacityMeasurable) return { bps: observedBps ?? estimateBps, capacityKnown: false };
  if (estimateBps === null) return { bps: observedBps, capacityKnown: false };
  if (observedBps !== null && observedBps > estimateBps * OVER_ESTIMATE_MARGIN) {
    return { bps: observedBps, capacityKnown: false };
  }
  return { bps: estimateBps, capacityKnown: true };
}

/**
 * Should the proactive clamp fire?
 *
 * Uses HEADROOM_CLAMP (1.0), not the selection headroom: the question is not
 * "could this link do better" but "is the current ask flatly unaffordable". Any
 * stricter test is self-fulfilling, because the estimate follows what we send.
 */
export function shouldClamp(current: ScreenShareQuality, estimateBps: number | null): boolean {
  if (estimateBps === null) return false; // no opinion is never a reason to clamp
  return presetBitrate(current) > estimateBps * HEADROOM_CLAMP;
}

/**
 * @param isActive  Poll while true.
 * @param resetKey  Changing this clears the sample window. Pass the sharing
 *                  state: samples taken during a camera-only call describe a
 *                  completely different load than the one a screen share is
 *                  about to put on the wire, and carrying them across would
 *                  judge the new load by the old one's behaviour.
 */
export function useUplinkEstimate(isActive: boolean, resetKey?: unknown): UplinkEstimate | null {
  const [estimate, setEstimate] = useState<UplinkEstimate | null>(null);

  useEffect(() => {
    if (!isActive) return;
    let cancelled = false;
    let pending = false;
    let samples: number[] = [];
    let previous: UplinkSample | null = null;

    const poll = async () => {
      // getStats may outlive both the interval and the share that requested it.
      if (pending) return;
      pending = true;
      try {
        const stats = await webrtcService.getStats().catch(() => null);
        if (cancelled) return;
        const sample = stats ? readUplinkSample(stats, performance.now()) : null;
        if (!sample) {
          samples = [];
          previous = null;
          setEstimate(null);
          return;
        }
        if (previous && previous.pairId !== sample.pairId) {
          samples = [];
          setEstimate(null);
        }
        const observed = throughputBps(previous, sample);
        previous = sample;
        samples = sample.bps === null ? [] : [...samples, sample.bps].slice(-WINDOW);
        if (sample.bps !== null && samples.length < MIN_SAMPLES) return;
        const { bps, capacityKnown } = reconcileEstimate(
          samples.length ? median(samples) : null,
          observed,
          isCapacityMeasurable(sample),
        );
        setEstimate(bps === null ? null : estimateFromBitrate(bps, capacityKnown, observed));
      } finally {
        pending = false;
      }
    };

    void poll();
    const interval = setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(interval);
      setEstimate(null);
    };
  }, [isActive, resetKey]);

  return estimate;
}
