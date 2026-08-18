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
