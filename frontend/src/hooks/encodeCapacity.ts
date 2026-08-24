import { FLOOR_RESOLUTION, LARGEST_RESOLUTION } from './operatingPoint';
import type { OutboundScreenStats } from '../types';
// Type-only, so this stays a compile-time reference in both directions.
import type { SenderHealth } from './useSenderHealth';

/**
 * What the sender's encoder can actually produce, as opposed to what the link
 * can carry.
 *
 * `chooseOperatingPoint` had three upper bounds — the budget (the link), the
 * preset (the user), and the viewport (the receiver) — and no fourth one for
 * the machine doing the encoding. That gap is what the reported failure fell
 * through: `auto` reaching 4K on a Retina viewport, VP9 with no hardware
 * encoder behind it, and an encode that could not run in realtime at that size.
 *
 * The receiver saw the result — a picture that froze and then jumped — and said
 * so, on a nine-second heartbeat. Nothing could act on it. `cpu-bound` is the
 * one verdict `nextBudget` answers by returning unchanged, so the viewer's
 * complaint never reached a branch that could move anything, and the ladder
 * holds for the same reason. Both modules' comments name the remedy and neither
 * implements it: `useSenderHealth` says "the right answers are a smaller
 * resolution or a cheaper codec", `qualityLadder` says "let the caller respond
 * by dropping resolution or reverting the codec". This module is the first of
 * those two answers.
 *
 * Deliberately NOT expressed as a bitrate. `SenderHealth`'s contract is that a
 * CPU limit "MUST NOT be answered by lowering the bitrate: fewer bits do not
 * buy CPU". Fewer PIXELS do. Cutting the pixel rate while leaving the budget
 * alone raises bits-per-pixel, so the picture this produces is smaller and
 * SHARPER, which is the same rate-distortion argument `operatingPoint` is
 * built on.
 *
 * Pure functions over numbers, like every other judgement here.
 */

/**
 * Share of a frame interval the encoder may spend and still be keeping up.
 *
 * `totalEncodeTime` sums per-frame encode durations, so a mean above the frame
 * interval means the encoder cannot sustain the rate it was asked for — it is
 * already dropping frames or about to. 0.7 leaves room for the jitter in a
 * three-second sample rather than waiting for the cliff to be unambiguous,
 * because by then the viewer has been watching a slideshow for a while.
 */
export const ENCODE_BUDGET_FRACTION = 0.7;

/**
 * How far the ceiling drops when the encoder is over the cliff.
 *
 * Roughly one rung: 1920x1080 -> 1600x900 is 0.69 of the pixels, 1600x900 ->
 * 1280x720 is 0.64. Cutting by about a rung per decision means the walk down
 * converges in a few steps instead of overshooting to the floor on the first
 * bad sample, which is the failure mode `nextBudget` was rewritten to remove.
 */
export const CAPACITY_BACKOFF = 0.75;

/** How far it relaxes after a quiet spell. Deliberately gentler than the cut. */
export const CAPACITY_RECOVER = 1.25;

/**
 * Shortest wait between cuts.
 *
 * One `useSenderHealth` sustain window (SUSTAIN_POLLS x POLL_INTERVAL_MS): no
 * evidence about a cut exists before nine seconds, so cutting faster than this
 * means cutting three times on one observation and landing at 0.42 of where we
 * started for a spike that one step would have cleared.
 */
export const CAPACITY_CUT_INTERVAL_MS = 9_000;

/**
 * How long the ceiling holds before it tries growing again.
 *
 * The same order as `MAX_BUDGET_PROBE_BACKOFF_MS`, and for the same reason: a
 * laptop that was busy compiling for a minute must not spend the rest of the
 * film paying for it, while a machine that genuinely cannot encode 4K should
 * not relearn that every nine seconds.
 */
export const CAPACITY_RETRY_MS = 120_000;

export interface CapacityState {
  /**
   * Pixels per second this sender has been shown to sustain, or null for no
   * opinion — the same "null means no opinion" the rest of this pipeline uses
   * (UplinkEstimate.capacityKnown, nextBudget's estimateBps, freshViewerReport).
   */
  maxPixelsPerSecond: number | null;
  /** When the ceiling last moved, in either direction. */
  lastChangeAt: number;
}

export interface CapacitySignals {
  now: number;
  health: SenderHealth;
  /** The previous poll's sample. The counters are cumulative; we want the delta. */
  previous: OutboundScreenStats | null;
  latest: OutboundScreenStats | null;
  /** Pixels per second currently being ASKED for — the quantity being bounded. */
  askedPixelsPerSecond: number;
  /** The frame rate that ask is at, which converts pixels/second to a picture. */
  fps: number;
}

export function initialCapacityState(): CapacityState {
  return { maxPixelsPerSecond: null, lastChangeAt: 0 };
}

/**
 * Mean seconds of encode time per frame between two samples.
 *
 * Deltas, not the running totals, for the reason `QualityMetrics` documents:
 * a rough first ten seconds stays in a cumulative mean forever, so an encoder
 * that recovered would never look recovered.
 *
 * null when any term is missing or the counters went backwards (a track swap
 * resets them). Never a partial estimate.
 */
export function encodeCostPerFrame(
  prev: OutboundScreenStats | null,
  next: OutboundScreenStats | null,
): number | null {
  if (!prev || !next) return null;
  const { totalEncodeTime: t0, framesEncoded: f0 } = prev;
  const { totalEncodeTime: t1, framesEncoded: f1 } = next;
  if (typeof t0 !== 'number' || typeof t1 !== 'number') return null;
  if (typeof f0 !== 'number' || typeof f1 !== 'number') return null;

  const frames = f1 - f0;
  const seconds = t1 - t0;
  if (frames <= 0 || seconds < 0) return null;
  return seconds / frames;
}

/**
 * Is the encoder over its cliff right now?
 *
 * Two independent witnesses, because each one alone has a blind spot. The
 * encode-time measurement is the direct question and answers before Chrome has
 * made up its mind, but Firefox and Safari publish neither term. A sustained
 * `cpu-bound` verdict is coarser and slower — nine seconds, and it needs
 * `qualityLimitationReason` — but it is what Chrome says about itself.
 */
export function overEncodeCliff(sig: CapacitySignals): boolean {
  if (sig.health === 'cpu-bound') return true;

  // A still screen makes the encode-time witness unreadable, so do not read it.
  // Divide the interval's encode seconds by the two or three frames a
  // motionless capture produced and one keyframe among them clears a per-frame
  // budget sized for thirty — a cliff verdict from an encoder that was very
  // nearly asleep. The other consequence of `source-idle` is that neither term
  // moved enough to mean anything either way, so there is nothing lost by
  // waiting for frames.
  if (sig.health === 'source-idle') return false;

  if (sig.fps <= 0) return false;
  const cost = encodeCostPerFrame(sig.previous, sig.latest);
  if (cost === null) return false;
  return cost > (1 / sig.fps) * ENCODE_BUDGET_FRACTION;
}

/**
 * Advance the encode ceiling.
 *
 * Down when the encoder is over its cliff, up after a quiet spell, and never
 * below the floor `operatingPoint` already defends: a ceiling that forbade the
 * smallest rung we are willing to send would make the whole chooser
 * unsatisfiable, and "unwatchable is worse than wasteful" is the order of
 * precedence that file already settled.
 */
export function nextCapacity(state: CapacityState, sig: CapacitySignals): CapacityState {
  if (sig.fps <= 0) return state;

  const floor = FLOOR_RESOLUTION.width * FLOOR_RESOLUTION.height * sig.fps;
  const ceiling = LARGEST_RESOLUTION.width * LARGEST_RESOLUTION.height * sig.fps;

  if (overEncodeCliff(sig)) {
    // Not more than once per sustain window: the effect of a cut has to be
    // observable before the next one, or three polls of one spike compound.
    if (state.maxPixelsPerSecond !== null && sig.now - state.lastChangeAt < CAPACITY_CUT_INTERVAL_MS) {
      return state;
    }
    // Cut from whichever is smaller — the ask, or a ceiling already below it.
    // Cutting from the ask alone would stall when the encoder has scaled itself
    // down; cutting from the ceiling alone would ignore an ask that never
    // reached it.
    const base = Math.min(state.maxPixelsPerSecond ?? Infinity, sig.askedPixelsPerSecond);
    if (!Number.isFinite(base) || base <= 0) return state;
    const cut = Math.max(floor, base * CAPACITY_BACKOFF);
    if (state.maxPixelsPerSecond !== null && cut >= state.maxPixelsPerSecond) return state;
    return { maxPixelsPerSecond: cut, lastChangeAt: sig.now };
  }

  // No opinion and nothing wrong — nothing to say.
  if (state.maxPixelsPerSecond === null) return state;

  if (sig.now - state.lastChangeAt <= CAPACITY_RETRY_MS) return state;

  const relaxed = state.maxPixelsPerSecond * CAPACITY_RECOVER;
  // Past the largest picture we would ever send, the bound stops being a bound.
  // Returning to null rather than growing forever keeps "no opinion" meaning
  // exactly that, and lets a machine that has proven itself out of the loop.
  if (relaxed >= ceiling) return { maxPixelsPerSecond: null, lastChangeAt: sig.now };
  return { maxPixelsPerSecond: relaxed, lastChangeAt: sig.now };
}
