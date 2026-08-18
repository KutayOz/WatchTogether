import {
  CONTENT_MODES,
  QUALITY_PRESETS,
  type ContentMode,
  type ScreenShareQuality,
  type Viewport,
} from '../types';
// Type-only, so this stays a compile-time reference: useSenderHealth imports
// webrtcService, which imports OperatingPoint from this file.
import type { SenderHealth } from './useSenderHealth';

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
 *
 * Derived, not guessed: the largest picture `auto` will send is 4K, and 4K at
 * 24 fps needs 6.97 Mbps merely to REACH target bpp. The old 6 Mbps therefore
 * could not fund 4K at all — raising `auto` past 1080p without raising this
 * would have changed nothing. Ten gives 4K24 a comfortable 0.050 bpp, and at 60
 * fps it lands the chooser on 1440p, which is the honest answer at that frame
 * rate anyway.
 */
export const AUTO_MAX_BITRATE = 10_000_000;

/**
 * Bits per pixel per frame past which more bits stop buying visible quality.
 *
 * Roughly three times TARGET_BPP. This exists because the budget measures what
 * the LINK can carry, not what the PICTURE can use, and the two came apart as
 * soon as the receiver's viewport started bounding resolution: someone watching
 * in a 1280x720 window on a fast link would otherwise be sent 720p at 0.45 bpp
 * — bits with nowhere to land, taken from a connection they are also using for
 * everything else.
 *
 * It is a ceiling on waste, not a target. Nothing is ever raised TO it.
 */
export const MAX_USEFUL_BPP = 0.1;

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
  // Exactly one third of 1080p, so the receiver's upscale is a clean 3x rather
  // than 854x480's 2.248x. The last rung we are willing to send; see MIN_VIDEO_BPS.
  { width: 640, height: 360 },
];

/** Bitrate granularity, in bps. See the quantisation note in chooseOperatingPoint. */
const BITRATE_STEP = 25_000;

/** The floor. Below this we stop shrinking and accept a soft picture. */
const SMALLEST = RESOLUTIONS[RESOLUTIONS.length - 1];

/**
 * The lowest audio tier, named because the video floor is derived from it.
 *
 * Extracted from audioReserve's tier expression rather than repeated: the two
 * numbers have to agree for minBudgetBps to be the budget at which the video
 * floor is actually achievable, and a duplicated literal is how they drift.
 */
const MIN_AUDIO_BPS = 64_000;

/**
 * Ceiling on audio's share of the budget.
 *
 * At the film floor (264 kbps) the 64 kbps tier is 24.2% — so this cap is
 * exactly tangent to the floor and inert everywhere above it. It exists so that
 * no caller can reproduce the state this floor was written for, where a budget
 * that had collapsed to ~100 kbps handed 64% of itself to audio and left the
 * video encoder with scraps.
 */
const MAX_AUDIO_SHARE = 0.25;

/**
 * The least video bitrate we will ever ask for, at a given frame rate.
 *
 * Defined as "the smallest rung, at TARGET_BPP" rather than picked: rounding up
 * to the next BITRATE_STEP puts all three content modes at 0.0362 bpp, so this
 * is one rule rather than three magic numbers.
 *
 *   film   24 fps -> 200 kbps
 *   motion 30 fps -> 250 kbps
 *   games  60 fps -> 500 kbps
 */
export function minVideoBps(fps: number): number {
  const exact = TARGET_BPP * SMALLEST.width * SMALLEST.height * fps;
  return Math.ceil(exact / BITRATE_STEP) * BITRATE_STEP;
}

/** The least total budget that can actually fund minVideoBps plus audio. */
export function minBudgetBps(fps: number): number {
  return minVideoBps(fps) + MIN_AUDIO_BPS;
}

/**
 * The box to assume for `auto` when the receiver has not said how big it is.
 *
 * 1080p, which is exactly what `auto` meant before it could be told otherwise.
 * Sending more than this to a display we know nothing about spends bits that
 * may have nowhere to land, and `auto` is the setting whose whole meaning is
 * "you decide" — so with no information it decides conservatively.
 */
const UNKNOWN_VIEWPORT: Viewport = { width: 1920, height: 1080 };

/**
 * The largest picture we are willing to send: the preset's box, bounded by what
 * the far end can actually display.
 *
 * The asymmetry between `auto` and a fixed preset is deliberate. `auto` means
 * "you decide", so an absent viewport report falls back to the conservative
 * assumption above. A fixed preset means "I decided" — the same principle
 * withUserChoice already encodes, that an explicit choice is a statement of
 * intent — so a report that never arrived must not quietly overrule it.
 */
export function resolutionBox(
  ceiling: ScreenShareQuality,
  viewport: Viewport | null,
): Viewport {
  const preset = QUALITY_PRESETS[ceiling] ?? QUALITY_PRESETS.auto;
  const bound = viewport ?? (ceiling === 'auto' ? UNKNOWN_VIEWPORT : null);
  if (!bound) return { width: preset.video.width, height: preset.video.height };
  return {
    width: Math.min(preset.video.width, bound.width),
    height: Math.min(preset.video.height, bound.height),
  };
}

/**
 * The most a given box can usefully spend at a given frame rate.
 *
 * Rounded DOWN to the quantisation step, where minVideoBps rounds up. A floor
 * rounds up so it stays achievable; a ceiling rounds down so it stays a
 * ceiling. Rounding this one up let the chosen point land at 0.1006 bpp — past
 * the very bound it exists to impose.
 *
 * Never below the floor: the chooser will send SMALLEST even when the box is
 * tinier than that, and what it sends has to remain fundable — otherwise a
 * viewport smaller than 640x360 would push the bitrate under the floor the rest
 * of this file exists to defend. On that path the floor wins and the bpp bound
 * gives way, which is the right order of precedence: unwatchable is worse than
 * wasteful.
 */
export function usefulVideoBps(box: Viewport, fps: number): number {
  const exact = MAX_USEFUL_BPP * box.width * box.height * fps;
  const quantised = Math.floor(exact / BITRATE_STEP) * BITRATE_STEP;
  return Math.max(minVideoBps(fps), quantised);
}

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
  const tier = budgetBps >= 3_000_000 ? 128_000 : budgetBps >= 1_500_000 ? 96_000 : MIN_AUDIO_BPS;
  // The share cap is defence-in-depth for direct callers. chooseOperatingPoint
  // floors the budget before it gets here, so on that path the cap never binds.
  return Math.min(tier, ceilingAudioBps, Math.floor(budgetBps * MAX_AUDIO_SHARE));
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
 * @param viewport   What the receiver can actually display, or null when it has
 *                   not said. A third upper bound alongside the budget and the
 *                   preset: pixels the far end cannot show are pixels nobody
 *                   sees, and the bits they cost are better spent on bpp.
 */
export function chooseOperatingPoint(
  budgetBps: number,
  mode: ContentMode,
  ceiling: ScreenShareQuality = 'auto',
  viewport: Viewport | null = null,
): OperatingPoint {
  const preset = QUALITY_PRESETS[ceiling] ?? QUALITY_PRESETS.auto;

  // The content mode asks for a frame rate; the preset may cap it.
  const fps = Math.min(CONTENT_MODES[mode].fps, preset.video.frameRate);

  /*
   * Floor the budget BEFORE audio takes its cut, so the reserve is never
   * computed against a collapsed number.
   *
   * The measurement that put this line here: a relayed TURN/TCP session whose
   * bandwidth estimate collapsed to its own ask drove the budget to ~25 kbps.
   * This function then dutifully asked the encoder for 854x480 at 24 fps on
   * 25 kbps — 0.0025 bpp, fourteen times below TARGET_BPP, an operating point
   * the rest of this file's reasoning does not admit exists. Chrome improvised:
   * 344x182 at 1 fps, a size smaller than any rung we offer.
   *
   * Below the floor we deliberately over-subscribe the link. That is the lesser
   * evil, because the alternative is not a smaller working stream — it is an
   * unwatchable one, and the pacer still adapts underneath us. A link genuinely
   * under 264 kbps should be TOLD it cannot carry a screen share, which is the
   * caller's job (see the floor toast in SessionRoom), not quietly served a
   * slideshow.
   */
  const budget = Math.max(budgetBps, minBudgetBps(fps));

  const audioBps = audioReserve(budget, preset.audio.bitrate);

  // The largest picture we will send, and with it the most that can usefully be
  // spent on one. Three bounds meet here: the link's (budget), the user's
  // (preset), and the receiver's (viewport).
  const box = resolutionBox(ceiling, viewport);

  // `bitrate: 0` means "budget decides" — clamp to the safety ceiling, never to
  // nothing. This is the line that removes the uncapped-encoder failure mode.
  const presetCeiling = preset.video.bitrate > 0 ? preset.video.bitrate : AUTO_MAX_BITRATE;
  const videoCeiling = Math.min(presetCeiling, usefulVideoBps(box, fps));
  const raw = Math.max(0, Math.min(budget - audioBps, videoCeiling));

  // Quantised, so a bandwidth estimate that wanders by a few kbps every three
  // seconds does not produce a fresh setParameters + applyConstraints on every
  // poll. Encoder churn is not free, and a 25 kbps step is far below anything
  // visible.
  const quantised = Math.round(raw / BITRATE_STEP) * BITRATE_STEP;
  // The floor again, now on the bitrate itself — quantisation and the preset's
  // audio reserve can both eat into a floored budget. Still under the ceiling:
  // every preset's video bitrate is comfortably above minVideoBps(60).
  const videoBps = Math.min(videoCeiling, Math.max(quantised, minVideoBps(fps)));

  const fitsCeiling = (r: { width: number; height: number }) =>
    r.width <= box.width && r.height <= box.height;

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
 * How far a probe reaches above the proven budget.
 *
 * Has to clear the measurement noise to be learnable: BITRATE_STEP is 12.5% of
 * the film floor, so 1.5x is four quantisation steps while 1.25x is two. It
 * also bounds recovery — ln(6.096M / 264k) / ln(1.5) is about eight probes, so
 * a link that collapsed to the floor is back at its ceiling in roughly a
 * minute and a half. The cost of overshooting is one bad ~9 s window, which
 * the revert branch undoes exactly.
 */
export const PROBE_FACTOR = 1.5;

/**
 * Shortest wait between probes, and the value the backoff resets to.
 *
 * SUSTAIN_POLLS (3) x POLL_INTERVAL_MS (3000) in useSenderHealth: no verdict
 * about a probe exists before nine seconds, so probing faster than this means
 * raising twice before learning whether the first raise held.
 */
export const PROBE_INTERVAL_MS = 9_000;

/** One sustain window plus a poll of slack — the point at which "no bad news" is news. */
export const PROBE_VERDICT_WINDOW_MS = 12_000;

/**
 * Longest wait between probes.
 *
 * A saturated link spends under 3% of its airtime probing at this spacing,
 * while a lift ride or a cell handover does not cost the rest of the film.
 * Deliberately shorter than qualityLadder's ten minutes: that backoff governs
 * whole-preset steps, and at 1.5x budget steps ten minutes would reproduce the
 * pinned-for-the-session failure this work exists to remove.
 */
export const MAX_BUDGET_PROBE_BACKOFF_MS = 120_000;

/**
 * Multiplicative decrease when we know we are short but have no trusted number
 * to follow down. The same 0.85 as HEADROOM_SELECT and UNDER_SERVED_RATIO, and
 * GCC's own decrease factor.
 */
export const BACKOFF_FACTOR = 0.85;

/**
 * Total bits per second a quality ceiling permits, video and audio together.
 *
 * Takes the same three bounds chooseOperatingPoint does, so the budget stops
 * climbing exactly where the picture stops improving. Without the viewport term
 * a small window on a fast link would keep probing upward forever against an
 * encoder configuration that could not change: harmless in the end, since the
 * clamp catches it, but it would burn every probe cycle learning nothing.
 */
export function budgetCeilingBps(
  quality: ScreenShareQuality,
  fps: number,
  viewport: Viewport | null = null,
): number {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.auto;
  const presetCeiling = preset.video.bitrate > 0 ? preset.video.bitrate : AUTO_MAX_BITRATE;
  const video = Math.min(presetCeiling, usefulVideoBps(resolutionBox(quality, viewport), fps));
  return video + preset.audio.bitrate;
}

export interface BudgetState {
  /** What we are spending now. */
  bps: number;
  /** The last value the link was proven to carry. A failed probe reverts here. */
  baseBps: number;
  /** True while a raise is in flight and unjudged. */
  probing: boolean;
  lastChangeAt: number;
  probeBackoffMs: number;
}

export interface BudgetSignals {
  now: number;
  /**
   * Trusted capacity in bps, or null for no opinion. Callers must pass null
   * rather than an untrusted number — see UplinkEstimate.capacityKnown.
   */
  estimateBps: number | null;
  health: SenderHealth;
  /** The receiver says this is not working. On `auto` this is its only route in. */
  viewerUnhappy: boolean;
  headroom: number;
  /** Owns the frame rate, and through it the floor. */
  mode: ContentMode;
  /** The user's ceiling, and through it the cap. */
  ceiling: ScreenShareQuality;
  /** What the receiver can display, or null. Bounds the cap alongside `ceiling`. */
  viewport: Viewport | null;
}

export function initialBudgetState(bps: number, now: number): BudgetState {
  return {
    bps,
    baseBps: bps,
    probing: false,
    lastChangeAt: now,
    probeBackoffMs: PROBE_INTERVAL_MS,
  };
}

/**
 * Advance the spendable budget.
 *
 * Two traps, and they pull in opposite directions.
 *
 * The first is the feedback spiral. `availableOutgoingBitrate` is bounded by
 * what we are already sending, so a budget recomputed as `estimate * headroom`
 * every tick makes the next estimate a fraction of this one, and the stream
 * walks to the floor with no single step ever being wrong.
 *
 * The second is the one that actually shipped, and it is the mirror image: a
 * budget that only ever follows the estimate can never RISE, because the
 * estimate cannot rise until we send more. The reported session sat at 30 kbps
 * on a link whose two ends had 200 Mbps and 30 Mbps, and nothing in the system
 * could propose sending more. `useSenderHealth` calls itself "the only signal
 * here that can say raise" — and it was never wired to this function.
 *
 * The resolution is that the only way to learn a link is faster is to send more
 * and watch. That is what a probe is; reverting EXACTLY to `baseBps` when one
 * fails is what makes trying safe, and is why repeated failure cannot ratchet.
 */
export function nextBudget(state: BudgetState, sig: BudgetSignals): BudgetState {
  const fps = Math.min(CONTENT_MODES[sig.mode].fps, QUALITY_PRESETS[sig.ceiling].video.frameRate);
  const floor = minBudgetBps(fps);
  // max(floor, ...) because the floor wins: a picture we refuse to go below
  // costs what it costs, even under a ceiling that would rather it did not.
  const cap = Math.max(floor, budgetCeilingBps(sig.ceiling, fps, sig.viewport));
  const clamp = (bps: number) => Math.min(cap, Math.max(floor, bps));

  const shortage = sig.health === 'under-served' || sig.viewerUnhappy;
  const target = sig.estimateBps === null ? null : sig.estimateBps * sig.headroom;

  // CPU pressure is not a bandwidth problem. Fewer bits do not buy the encoder
  // any CPU — but a raise we just made is the one thing that could have caused
  // it, so abandon any probe in flight and then hold.
  if (sig.health === 'cpu-bound') {
    if (!state.probing) return state;
    return { ...state, bps: clamp(state.baseBps), probing: false, lastChangeAt: sig.now };
  }

  // A probe that made things worse. Revert to the proven value exactly, not by
  // a factor: this is the property that stops repeated failure from decaying
  // the budget, and it is the whole reason `baseBps` is carried.
  if (state.probing && shortage) {
    const reverted = clamp(state.baseBps);
    return {
      bps: reverted,
      baseBps: reverted,
      probing: false,
      lastChangeAt: sig.now,
      probeBackoffMs: Math.min(state.probeBackoffMs * 2, MAX_BUDGET_PROBE_BACKOFF_MS),
    };
  }

  // A probe that held. Bank it, and reset the backoff — without the reset one
  // early failure would permanently slow every later recovery.
  if (state.probing && sig.now - state.lastChangeAt > PROBE_VERDICT_WINDOW_MS) {
    return { ...state, baseBps: state.bps, probing: false, probeBackoffMs: PROBE_INTERVAL_MS };
  }

  // Genuine shortage. Follow a trusted estimate down; without one, back off
  // multiplicatively rather than standing still while the picture breaks.
  //
  // The viewer's report gets the multiplicative path even when a trusted
  // estimate exists, because the two measure different things: the estimate is
  // the path's CAPACITY, the report is what actually ARRIVED. A capacity
  // estimate sitting above what we already spend makes `min(bps, target)` a
  // no-op, so without this branch a far end that is freezing on a decoder it
  // cannot feed — the one shortage GCC genuinely cannot see, since nothing is
  // being lost in flight — could complain forever with nothing moving. Lowering
  // the budget is a real answer there: it lowers the resolution too.
  if (shortage) {
    const byEstimate = target === null ? state.bps : Math.min(state.bps, target);
    const estimateSaysNothing = byEstimate >= state.bps;
    const lowered =
      target === null || (sig.viewerUnhappy && estimateSaysNothing)
        ? state.bps * BACKOFF_FACTOR
        : byEstimate;
    const bps = clamp(lowered);
    if (bps === state.bps) return state;
    return { ...state, bps, baseBps: bps, lastChangeAt: sig.now };
  }

  // New information rather than a gamble: a trusted estimate above what we are
  // spending is the link telling us directly that it has more.
  if (target !== null && target > state.bps) {
    const bps = clamp(target);
    if (bps !== state.bps) return { ...state, bps, baseBps: bps, lastChangeAt: sig.now };
  }

  // Room to grow, with nothing measured to justify it. Probe.
  const wantsMore = sig.health === 'satisfied' || sig.health === 'self-limited';
  if (wantsMore && sig.now - state.lastChangeAt > state.probeBackoffMs) {
    const bps = clamp(state.bps * PROBE_FACTOR);
    // Already at the cap. Returning here rather than marking `probing` is what
    // stops the loop stalling at the top the way it used to stall at the floor:
    // a probe that cannot move the budget has nothing to judge.
    if (bps === state.bps) return state;
    return { ...state, bps, baseBps: state.bps, probing: true, lastChangeAt: sig.now };
  }

  return state;
}

/** True when two viewports are the same box, nulls included. */
export function sameViewport(a: Viewport | null, b: Viewport | null): boolean {
  if (!a || !b) return a === b;
  return a.width === b.width && a.height === b.height;
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
