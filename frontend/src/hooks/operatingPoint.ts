import {
  CONTENT_MODES,
  QUALITY_PRESETS,
  type ContentMode,
  type ScreenShareQuality,
} from '../types';

/**
 * Where to sit on the rate-distortion curve for a given budget.
 *
 * The old design offered six fixed rungs and asked "which of these fits?".
 * Between `low` (1.5 Mbps, 720p) and `medium` (4 Mbps, 1080p) there was nothing,
 * so a 2 Mbps link — unable to afford `medium`, and told `low` was all it could
 * have — ran 720p while leaving a third of its uplink unused. Worse, a link
 * below 2 Mbps could afford no fixed rung at all and fell through to `auto`,
 * which set no ceiling whatsoever.
 *
 * Six points cannot sit on a curve. A function can.
 *
 * The governing quantity is **bits per pixel per frame**:
 *
 *     bpp = bitrate / (width * height * fps)
 *
 * Quality tracks bpp far more closely than it tracks resolution. 1080p at
 * 0.026 bpp looks visibly worse than 900p at 0.046 bpp on the same wire,
 * because the second picture has nearly twice as many bits describing each
 * pixel it actually sends — and the display upscales the smaller one for free.
 * So the right move on a constrained link is not always the biggest picture.
 *
 * Everything here is a pure function of numbers, which is how this codebase
 * keeps its judgement testable (see estimateFromBitrate, calculateQualityScore).
 */

/**
 * The bpp we try to stay at or above.
 *
 * Calibrated for VP9 on film-like motion content, which is what this app
 * carries. Roughly: >= 0.035 looks good, 0.025-0.035 is acceptable, below 0.02
 * is visibly soft. VP9's screen-content tools and the fact that captured film
 * is already denoised and grain-free both buy a little headroom over what these
 * numbers would mean for a camera feed.
 */
export const TARGET_BPP = 0.035;

/**
 * Hard ceiling for the `auto` preset, in bps.
 *
 * `auto` used to `delete enc.maxBitrate`, leaving the encoder unbounded. On a
 * link slower than the encoder's ambition that is the worst of both worlds: it
 * overshoots the path, the pacer builds a standing queue, the delay-based
 * controller sees the queue as congestion, and the picture goes soft and laggy
 * simultaneously. A finite ceiling is strictly better even when it is generous.
 */
export const AUTO_MAX_BITRATE = 6_000_000;

/**
 * Resolutions we are willing to send, largest first.
 *
 * All 16:9. Non-16:9 desktops fit inside the box preserving aspect (1920x1200
 * captures as 1728x1080, 3440x1440 as 1920x804), which is the desirable
 * behaviour: fewer pixels for the same bits.
 */
const RESOLUTIONS: readonly { width: number; height: number }[] = [
  { width: 3840, height: 2160 },
  { width: 2560, height: 1440 },
  { width: 1920, height: 1080 },
  { width: 1600, height: 900 },
  { width: 1280, height: 720 },
  { width: 960, height: 540 },
  { width: 854, height: 480 },
];

/** Bitrate granularity, in bps. See the quantisation note in chooseOperatingPoint. */
const BITRATE_STEP = 25_000;

/** The floor. Below this we stop shrinking and accept a soft picture. */
const SMALLEST = RESOLUTIONS[RESOLUTIONS.length - 1];

export interface OperatingPoint {
  width: number;
  height: number;
  fps: number;
  videoBps: number;
  audioBps: number;
  /** What the chosen point actually achieves. Below TARGET_BPP when the budget forced it. */
  bpp: number;
}

/**
 * Audio reserve, taken off the top before video gets a look in.
 *
 * Tiered rather than fixed because a flat 128 kbps is 13% of a 1 Mbps budget
 * and 3% of a 4 Mbps one — the same number means very different things. Opus is
 * transparent for film at 96k stereo and still good at 64k, so the low tiers
 * give up very little to hand the video a materially larger share.
 */
function audioReserve(budgetBps: number, ceilingAudioBps: number): number {
  const tier = budgetBps >= 3_000_000 ? 128_000 : budgetBps >= 1_500_000 ? 96_000 : 64_000;
  return Math.min(tier, ceilingAudioBps);
}

/**
 * Pick width/height/fps/bitrate for a measured budget.
 *
 * @param budgetBps  Total bits per second available to the share, audio included.
 *                   Callers pass an already-conservative number (the uplink
 *                   estimate times its headroom factor), so this function
 *                   spends what it is given rather than discounting again.
 * @param mode       Content mode; owns frame rate.
 * @param ceiling    The quality preset the user selected, as an upper bound.
 */
export function chooseOperatingPoint(
  budgetBps: number,
  mode: ContentMode,
  ceiling: ScreenShareQuality = 'auto',
): OperatingPoint {
  const preset = QUALITY_PRESETS[ceiling] ?? QUALITY_PRESETS.auto;

  // The content mode asks for a frame rate; the preset may cap it.
  const fps = Math.min(CONTENT_MODES[mode].fps, preset.video.frameRate);

  const audioBps = audioReserve(budgetBps, preset.audio.bitrate);

  // `bitrate: 0` means "budget decides" — clamp to the safety ceiling, never to
  // nothing. This is the line that removes the uncapped-encoder failure mode.
  const videoCeiling = preset.video.bitrate > 0 ? preset.video.bitrate : AUTO_MAX_BITRATE;
  const raw = Math.max(0, Math.min(budgetBps - audioBps, videoCeiling));

  // Quantised, so a bandwidth estimate that wanders by a few kbps every three
  // seconds does not produce a fresh setParameters + applyConstraints on every
  // poll. Encoder churn is not free, and a 25 kbps step is far below anything
  // visible.
  const videoBps = Math.round(raw / BITRATE_STEP) * BITRATE_STEP;

  const fitsCeiling = (r: { width: number; height: number }) =>
    r.width <= preset.video.width && r.height <= preset.video.height;

  // The largest resolution that still clears TARGET_BPP at this bitrate and
  // frame rate. Walking largest-first and taking the first hit gives exactly
  // the convex-hull point: anything bigger would be below target, anything
  // smaller would waste resolution we could afford.
  const chosen =
    RESOLUTIONS.find((r) => fitsCeiling(r) && videoBps / (r.width * r.height * fps) >= TARGET_BPP) ??
    // Nothing clears target — the link cannot carry a good picture at any size.
    // Send the smallest thing we allow rather than a large smeared one.
    RESOLUTIONS.filter(fitsCeiling).at(-1) ??
    SMALLEST;

  return {
    width: chosen.width,
    height: chosen.height,
    fps,
    videoBps,
    audioBps,
    bpp: videoBps / (chosen.width * chosen.height * fps),
  };
}

/**
 * Advance the spendable budget, without letting it decay on our own account.
 *
 * The subtle version of the feedback trap. `availableOutgoingBitrate` is
 * bounded by what we are currently sending, so if the budget is simply
 * `estimate * headroom` every tick, then spending 85% of the estimate makes the
 * next estimate ~85% of this one, and so on down. Nothing is ever "wrong" at
 * any single step, and the stream quietly walks to the floor.
 *
 * The asymmetry that fixes it: a link that is *serving* our ask has proven it
 * can carry at least that much, so the budget must not fall on the strength of
 * an estimate we ourselves suppressed. Only an encoder that is genuinely
 * under-served — asking for its ceiling and not getting it — is evidence the
 * link shrank, and only then does the budget follow the estimate down.
 *
 * @param previous  Last budget, or null on the first observation.
 * @param estimateBps  Measured uplink, or null where the browser will not say.
 * @param underServed  Sender health says bandwidth-limited below its ceiling.
 * @param headroom  Fraction of the estimate we are willing to claim.
 */
export function nextBudget(
  previous: number | null,
  estimateBps: number | null,
  underServed: boolean,
  headroom: number,
): number | null {
  // No opinion from the browser (Firefox) is not a reason to move anything.
  if (estimateBps === null) return previous;

  const target = estimateBps * headroom;
  if (previous === null) return target;

  // Genuine shortage: believe the estimate, including downward.
  if (underServed) return Math.min(previous, target);

  // Otherwise never fall — the link is meeting the ask, so any shortfall in the
  // estimate is our own restraint being reflected back at us.
  return Math.max(previous, target);
}

/** True when two points would produce an identical encoder configuration. */
export function sameOperatingPoint(a: OperatingPoint | null, b: OperatingPoint | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.fps === b.fps &&
    a.videoBps === b.videoBps &&
    a.audioBps === b.audioBps
  );
}
