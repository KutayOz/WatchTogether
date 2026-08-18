import { useCallback, useEffect, useRef, useState } from 'react';
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
  const supportedQualities = {} as Record<ScreenShareQuality, boolean>;

  for (const key of Object.keys(QUALITY_PRESETS) as ScreenShareQuality[]) {
    // `auto` sets no ceiling and lets the encoder track the estimator itself,
    // so it fits by definition — and it is the honest answer on a link too
    // slow for even the lowest fixed preset.
    //
    // When capacity is unknown the number in hand is a lower bound, so it can
    // say a preset FITS but never that one does not. The reported failure is
    // exactly this: a TCP-relay estimate of 30 kbps disabled all five fixed
    // presets (MediaControls sets `disabled={!isSupported}`), so the collapse
    // took away the only manual escape from itself.
    supportedQualities[key] =
      key === 'auto' || !capacityKnown || presetBitrate(key) <= budget;
  }

  // The best fixed preset that fits. QUALITY_LADDER carries the ordering,
  // because "cheapest first" is a property of the ladder and not of the object
  // literal's declaration order — and duplicating it here is how a new rung
  // ends up silently uncovered.
  const affordable = QUALITY_LADDER.filter((key) => supportedQualities[key]);

  return {
    uplinkMbps: Math.round((bitsPerSecond / 1_000_000) * 10) / 10,
    uplinkBps: bitsPerSecond,
    budgetBps: budget,
    // Nothing fixed fits: hand back `auto` so the encoder adapts downward
    // instead of the UI recommending a preset that cannot be sustained. With
    // capacity unknown there is nothing to recommend FROM, so `auto` again.
    recommendedQuality: capacityKnown ? (affordable.at(-1) ?? 'auto') : 'auto',
    supportedQualities,
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
  bps: number;
  bytesSent: number | null;
  /** How we reach the TURN server, when relayed: udp | tcp | tls. */
  relayProtocol?: string;
  atMs: number;
}

/**
 * Pull one sample off the active candidate pair.
 *
 * Returns null when the browser does not publish `availableOutgoingBitrate` —
 * Firefox does not — and null must mean "do not clamp", never "clamp to the
 * lowest". A guess is worse than no opinion here: it would silently cap quality
 * for every user of a browser that simply declines to answer the question.
 */
export function readUplinkSample(stats: RTCStatsReport, atMs: number): UplinkSample | null {
  let found: UplinkSample | null = null;
  let foundNominated = false;

  stats.forEach((report) => {
    if (report.type !== 'candidate-pair') return;
    const pair = report as RTCStats & CandidatePairStats;
    if (pair.state !== 'succeeded') return;
    if (typeof pair.availableOutgoingBitrate !== 'number') return;
    // More than one pair can be in 'succeeded'; the nominated one carries the
    // traffic. Prefer it, but take any succeeded pair over nothing.
    if (found !== null && foundNominated && !pair.nominated) return;

    const local = pair.localCandidateId
      ? (stats.get(pair.localCandidateId) as (RTCStats & { relayProtocol?: string }) | undefined)
      : undefined;

    found = {
      pairId: pair.id ?? report.id,
      bps: pair.availableOutgoingBitrate,
      bytesSent: typeof pair.bytesSent === 'number' ? pair.bytesSent : null,
      relayProtocol: local?.relayProtocol,
      atMs,
    };
    foundNominated = pair.nominated === true;
  });

  return found;
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
  const samplesRef = useRef<number[]>([]);
  // Previous reading, for the bytesSent delta. Held separately from the median
  // window because throughput is a difference, not a sample.
  const lastSampleRef = useRef<UplinkSample | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const stats = await webrtcService.getStats();
    if (!stats) return;

    // performance.now() at read time, not Date.now(): the same monotonic clock
    // useQualityMonitor uses for its own deltas, and immune to wall-clock jumps.
    const sample = readUplinkSample(stats, performance.now());
    if (sample === null) return;

    const observed = throughputBps(lastSampleRef.current, sample);
    lastSampleRef.current = sample;

    const samples = [...samplesRef.current, sample.bps].slice(-WINDOW);
    samplesRef.current = samples;
    if (samples.length < MIN_SAMPLES) return;

    // Median first, then reconcile: one outlier reading should not be able to
    // declare the estimator contradicted.
    const { bps, capacityKnown } = reconcileEstimate(
      median(samples),
      observed,
      isCapacityMeasurable(sample),
    );
    if (bps === null) return;

    setEstimate(estimateFromBitrate(bps, capacityKnown, observed));
  }, []);

  useEffect(() => {
    if (!isActive) return;

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    // Teardown rather than an `else` branch: clearing on the way out means the
    // next call starts from nothing, without a synchronous setState in the
    // effect body on every render where isActive is already false.
    //
    // Samples belong to one connection — carrying them forward would judge a
    // new link by the old one's behaviour — and the estimate goes with them,
    // because a stale number is what would clamp the next call before its own
    // window has filled.
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      samplesRef.current = [];
      lastSampleRef.current = null;
      setEstimate(null);
    };
  }, [isActive, poll, resetKey]);

  return estimate;
}
