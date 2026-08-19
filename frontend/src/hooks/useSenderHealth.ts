import { useCallback, useEffect, useRef, useState } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { OutboundScreenStats } from '../types';

/**
 * Is the encoder getting what it asked for?
 *
 * This replaces `availableOutgoingBitrate` as the CONTROL input for quality,
 * and the reason is a feedback trap in the old design. Chrome's estimate is
 * bounded by what you are already sending: clamp the encoder down and the next
 * estimate falls with it, which justifies clamping again. The estimator ends up
 * measuring the cage it is locked in, and a link ratchets to the floor without
 * ever having been that slow.
 *
 * Asking the encoder instead inverts the confound. We tell it a ceiling; it
 * reports what it could actually achieve. That answer is about the link, not
 * about our own restraint — and it is naturally hysteretic, because once we
 * clamp to a point the encoder can sustain, `targetBitrate` sits AT the ceiling
 * and "under-served" simply stops being true. The spiral cannot form.
 *
 * It is also the only signal here that can say *raise*.
 */

const POLL_INTERVAL_MS = 3000;

/** Consecutive polls before a verdict is trusted. Three polls ~= 9 seconds. */
const SUSTAIN_POLLS = 3;

/** Below this fraction of the ceiling, the encoder is not getting its ask. */
const UNDER_SERVED_RATIO = 0.85;

/** At or above this fraction, it is comfortably served and there may be room. */
const SATISFIED_RATIO = 0.95;

export type SenderHealth =
  /** Bandwidth-limited and materially below the configured ceiling. */
  | 'under-served'
  /** Hitting its ceiling with no limitation — there may be headroom above. */
  | 'satisfied'
  /**
   * Got everything we asked for, and the picture is STILL being degraded.
   *
   * `targetBitrate` is `min(our maxBitrate, the estimator's allocation)`, so
   * `targetBitrate` sitting at our ceiling proves the estimator is offering at
   * least that much. Reason 'bandwidth' alongside it therefore does not mean
   * the link is short — it means OUR CEILING is what the encoder is bumping
   * against. That is a reason to raise, and the classifier used to throw it
   * away: the reported collapse sat here (targetBitrate 30k against a 25k
   * ceiling, ratio 1.2) and got 'unknown', which froze the budget and reset the
   * ladder's good-poll count on every single poll. A deadlock, not a slide.
   */
  | 'self-limited'
  /**
   * Encoder cannot keep up. MUST NOT be answered by lowering the bitrate:
   * fewer bits do not buy CPU, they just make the picture worse for nothing.
   * The right answers are a smaller resolution or a cheaper codec.
   *
   * Both of those exist now, and neither is a bitrate. `encodeCapacity` bounds
   * the PIXEL rate — which leaves the bitrate alone, so bits per pixel actually
   * rises as the picture shrinks — and `shouldDowngradeCodec` below moves a
   * software VP9 encode to H.264. This verdict used to reach a `return state`
   * in every controller and nothing else at all, which is how a share that
   * froze and jumped on the receiver could do it from the first second and
   * never recover: the viewer's own report is read AFTER this branch, so a
   * CPU-bound sender could not even hear the complaint.
   */
  | 'cpu-bound'
  /** Not sharing, or the browser does not publish enough to judge. */
  | 'unknown';

/**
 * Classify a single sample.
 *
 * Exported and pure because this is the part with the judgement in it — the
 * same convention as estimateFromBitrate and calculateQualityScore.
 *
 * @param configuredBps The ceiling we set, i.e. the operating point's videoBps.
 */
export function classifySenderHealth(
  stats: OutboundScreenStats | null,
  configuredBps: number | null,
): SenderHealth {
  if (!stats) return 'unknown';

  // CPU first: it is the one verdict whose correct response is different in
  // kind, so it must never be masked by a bandwidth reading.
  if (stats.qualityLimitationReason === 'cpu') return 'cpu-bound';

  // Without both terms there is no ratio to judge, and a guess here would drive
  // the ladder. Firefox and Safari land in this branch.
  if (typeof stats.targetBitrate !== 'number' || !configuredBps || configuredBps <= 0) {
    return 'unknown';
  }

  const ratio = stats.targetBitrate / configuredBps;

  if (stats.qualityLimitationReason === 'bandwidth' && ratio < UNDER_SERVED_RATIO) {
    return 'under-served';
  }
  if (stats.qualityLimitationReason === 'none' && ratio >= SATISFIED_RATIO) {
    return 'satisfied';
  }
  // Served in full, yet still limited by something other than CPU. The ceiling
  // we set is the binding constraint — see 'self-limited' above.
  if (ratio >= SATISFIED_RATIO) {
    return 'self-limited';
  }
  return 'unknown';
}

/**
 * Is this encoder running in software?
 *
 * `encoderImplementation` is a free-form browser string, which is why this is a
 * match against what browsers actually publish rather than a lookup: Chrome
 * reports 'libvpx' / 'libvpx-vp9' / 'libaom' / 'OpenH264' for its own encoders
 * and 'ExternalEncoder' (plus platform names like 'VideoToolbox' and
 * 'MediaFoundationVideoEncodeAccelerator') when the work is on silicon.
 * Simulcast wraps the name — 'SimulcastEncoderAdapter (libvpx, libvpx)' — so
 * this searches rather than compares.
 *
 * Unknown is NOT software. A codec downgrade costs the viewer a decoder
 * teardown and a keyframe, and a browser that publishes nothing here (Firefox,
 * Safari) should get the pixel bound instead, which costs nothing.
 */
export function isSoftwareEncoder(implementation: string | null): boolean {
  if (!implementation) return false;
  return /libvpx|libaom|openh264|ffmpeg|libx264/i.test(implementation);
}

/**
 * Should this share give up on its codec?
 *
 * Only when both halves are true: the encoder is CPU-bound, and it is running
 * in software. A hardware encoder that is CPU-bound is telling us something
 * about the machine, not about the codec, and swapping codecs would spend a
 * keyframe to learn nothing.
 *
 * Pure and exported for the same reason `classifySenderHealth` is — this is
 * the part with the judgement in it, and the caller only does the plumbing.
 */
export function shouldDowngradeCodec(
  stats: OutboundScreenStats | null,
  health: SenderHealth,
): boolean {
  if (health !== 'cpu-bound') return false;
  return isSoftwareEncoder(stats?.encoderImplementation ?? null);
}

export interface SenderHealthState {
  /** The sustained verdict — only set once SUSTAIN_POLLS agree. */
  health: SenderHealth;
  /** How many consecutive polls have agreed. Lets callers require a longer run. */
  streak: number;
  /** Most recent raw sample, for display. */
  latest: OutboundScreenStats | null;
}

/**
 * @param isActive      Poll while true (i.e. while sharing).
 * @param configuredBps The ceiling currently applied, so the ratio is honest.
 */
export function useSenderHealth(
  isActive: boolean,
  configuredBps: number | null,
): SenderHealthState {
  const [state, setState] = useState<SenderHealthState>({
    health: 'unknown',
    streak: 0,
    latest: null,
  });

  // Refs, not state: the poller must read the *current* ceiling and streak
  // without re-creating the interval every time either changes.
  const configuredRef = useRef(configuredBps);
  useEffect(() => {
    configuredRef.current = configuredBps;
  }, [configuredBps]);

  const runRef = useRef<{ verdict: SenderHealth; count: number }>({
    verdict: 'unknown',
    count: 0,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const stats = await webrtcService.getOutboundScreenStats().catch(() => null);
    const verdict = classifySenderHealth(stats, configuredRef.current);

    const run = runRef.current;
    run.count = verdict === run.verdict ? run.count + 1 : 1;
    run.verdict = verdict;

    setState({
      // Report the verdict only once it has held. A single bad 3-second window
      // — a passing wifi dip, someone else on the link starting a download —
      // must not move anyone's quality.
      health: run.count >= SUSTAIN_POLLS ? verdict : 'unknown',
      streak: run.count,
      latest: stats,
    });
  }, []);

  useEffect(() => {
    if (!isActive) return;

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      runRef.current = { verdict: 'unknown', count: 0 };
      setState({ health: 'unknown', streak: 0, latest: null });
    };
  }, [isActive, poll]);

  return state;
}
