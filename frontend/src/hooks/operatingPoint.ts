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
 * It is a ceiling on waste, not a target. Nothing is ever raised TO it — see
 * PROBE_CEILING_BPP, which is what actually bounds the climb. That sentence was
 * false for a while: `budgetCeilingBps` was built from this number and
 * `nextBudget` raised the budget TO its cap, so within about thirty seconds
 * every share on a link with headroom settled at 1080p24 / 4.98 Mbps — 0.100
 * bpp, three times TARGET_BPP. The invariant stated here was contradicted by
 * the reducer two hundred lines below it.
 */
export const MAX_USEFUL_BPP = 0.1;

/**
 * The bpp an upward move is allowed to reach for.
 *
 * MAX_USEFUL_BPP is where more bits stop buying anything at all; this is where
 * they stop being worth ASKING for on speculation. About 1.4x TARGET_BPP: enough
 * headroom that a scene with more motion than the last one does not immediately
 * look soft, far short of the 3x the climb used to take.
 *
 * The distinction matters because the two numbers answer different questions. A
 * trusted estimate saying "the link has this much" is measurement, and
 * MAX_USEFUL_BPP still clamps it. A probe is a guess, and a guess that spends
 * three times what the picture needs costs the viewer twice: it oversubscribes
 * a home uplink, and it asks a software encoder for a bitrate that can push it
 * over its cliff — the state nothing in this system could recover from.
 *
 * 1080p24 lands at 2.49 Mbps here, against 4.98 before.
 */
export const PROBE_CEILING_BPP = 0.05;

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
 * The two ends of the rung list.
 *
 * Exported so `encodeCapacity` can express its ceiling in the same pixels this
 * file chooses from, rather than repeating 640x360 and 3840x2160 as literals —
 * a duplicated literal is how the floor here and the floor there drift apart,
 * which is the reason MIN_AUDIO_BPS was extracted a few lines below.
 */
export const FLOOR_RESOLUTION = SMALLEST;
export const LARGEST_RESOLUTION = RESOLUTIONS[0];

/**
 * The lowest audio tier, named because the video floor is derived from it.
 *
 * Extracted from audioReserve's tier expression rather than repeated: the two
 * numbers have to agree for minBudgetBps to be the budget at which the video
 * floor is actually achievable, and a duplicated literal is how they drift.
 */
const MIN_AUDIO_BPS = 64_000;

/**
 * What the REST of the call costs while a share is on the wire.
 *
 * The screen share is never alone on the connection, and until now this file
 * behaved as though it were: `budgetBps` was documented as "total bits per
 * second available to the share, audio included" and then spent entirely on the
 * share, while `applyCameraEncoding` and the mic quietly took another 88 kbps
 * off the same uplink. The mic's own comment claimed it was "now a known line
 * item rather than an assumption"; it was known to webrtcService and to nothing
 * else.
 *
 * A percentage allowance cannot cover this, which is why HEADROOM_SELECT's 15%
 * was not already doing the job. The companion streams are a FIXED cost, so a
 * proportional discount over-covers where it does not matter (300 kbps of slack
 * at a 2 Mbps budget) and under-covers exactly where it does (60 kbps at 400).
 * And on a TCP-relayed path there is no discount at all: `estimateBps` is null,
 * `headroom` never multiplies anything, and the budget is a pure probe-and-
 * backoff number. That is the path the captured collapse ran on, where 88 kbps
 * unaccounted was 27% of a floor-level budget.
 *
 * These are the values webrtcService applies — imported from here rather than
 * declared there, so the two cannot drift. Same reason MIN_AUDIO_BPS was
 * extracted just above.
 */
export const CAMERA_BPS_WHILE_SHARING = 64_000;
export const MIC_BPS = 24_000;
export const COMPANION_STREAMS_BPS = CAMERA_BPS_WHILE_SHARING + MIC_BPS;

/**
 * Ceiling on audio's share of the budget.
 *
 * Measured against what the SHARE has to divide, not against the whole budget —
 * see minShareBps. At the film share floor (264 kbps) the 64 kbps tier is
 * 24.2%, so this cap is exactly tangent to the floor and inert everywhere above
 * it. It exists so that no caller can reproduce the state this floor was
 * written for, where a budget that had collapsed to ~100 kbps handed 64% of
 * itself to audio and left the video encoder with scraps.
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

/**
 * The least the SHARE itself needs: the video floor plus the cheapest audio.
 *
 * Split out from minBudgetBps because the two answer different questions now
 * that the budget has to pay for more than the share. This is what audio and
 * video divide between them; minBudgetBps is what has to be on the wire for
 * this much to reach them.
 */
export function minShareBps(fps: number): number {
  return minVideoBps(fps) + MIN_AUDIO_BPS;
}

/**
 * The least total budget that can actually fund minShareBps.
 *
 * Its own name was a promise this function did not keep: it returned the
 * share's floor and called it the budget's, so a budget sitting exactly here
 * left the video encoder 88 kbps short of the floor the rest of this file
 * exists to defend. With the companion streams counted, a budget of exactly
 * this much puts the chooser at exactly minVideoBps — which is what "the least
 * total budget that can fund the floor" has to mean.
 */
export function minBudgetBps(fps: number): number {
  return minShareBps(fps) + COMPANION_STREAMS_BPS;
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
  fps = 0,
  maxPixelsPerSecond: number | null = null,
): Viewport {
  const preset = QUALITY_PRESETS[ceiling] ?? QUALITY_PRESETS.auto;
  const bound = viewport ?? (ceiling === 'auto' ? UNKNOWN_VIEWPORT : null);
  const box = bound
    ? {
        width: Math.min(preset.video.width, bound.width),
        height: Math.min(preset.video.height, bound.height),
      }
    : { width: preset.video.width, height: preset.video.height };
  return withinEncodeCapacity(box, fps, maxPixelsPerSecond);
}

/**
 * The box, shrunk to what the sender's own encoder has been shown to sustain.
 *
 * The fourth bound, and the only one that is about the machine rather than the
 * link, the user, or the far end. It exists because `cpu-bound` was a state the
 * whole control loop answered by holding: the budget could not move, the ladder
 * could not move, and the viewer's report — the one signal that knew the picture
 * was freezing — reached neither. Something had to be able to come down, and
 * pixels are the thing a CPU limit is actually about. `SenderHealth`'s contract
 * that a CPU limit "MUST NOT be answered by lowering the bitrate" is preserved
 * exactly: the bitrate is untouched, so bpp RISES as this shrinks the picture.
 *
 * null means no opinion, the same as everywhere else in this pipeline.
 */
function withinEncodeCapacity(
  box: Viewport,
  fps: number,
  maxPixelsPerSecond: number | null,
): Viewport {
  if (maxPixelsPerSecond === null || fps <= 0) return box;
  const allowed = maxPixelsPerSecond / fps;
  const pixels = box.width * box.height;
  if (pixels <= allowed) return box;
  // Area goes with the square of a linear factor, so the sides go with the
  // square root. Aspect is preserved because the rungs are all 16:9 and this
  // box is what they get tested against.
  const scale = Math.sqrt(allowed / pixels);
  return {
    // The floor still wins. A bound that excluded every rung we are willing to
    // send would leave the chooser nothing to pick, and the precedence is
    // already settled two functions down: unwatchable is worse than wasteful.
    width: Math.max(SMALLEST.width, Math.floor(box.width * scale)),
    height: Math.max(SMALLEST.height, Math.floor(box.height * scale)),
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
export function usefulVideoBps(box: Viewport, fps: number, bpp = MAX_USEFUL_BPP): number {
  const exact = bpp * box.width * box.height * fps;
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
 * @param capacityPixelsPerSecond
 *                   What this machine's encoder has been shown to sustain, or
 *                   null for no opinion. The fourth bound, and the only one
 *                   about the sender itself — see withinEncodeCapacity.
 */
export function chooseOperatingPoint(
  budgetBps: number,
  mode: ContentMode,
  ceiling: ScreenShareQuality = 'auto',
  viewport: Viewport | null = null,
  capacityPixelsPerSecond: number | null = null,
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
   * under minBudgetBps (352 kbps for film, once the camera and mic are counted)
   * should be TOLD it cannot carry a screen share, which is the caller's job
   * (see the floor toast in SessionRoom), not quietly served a slideshow.
   */
  const budget = Math.max(budgetBps, minBudgetBps(fps));

  /*
   * What the SHARE has to divide, once the rest of the call is paid for.
   *
   * The camera thumbnail and the mic are on this uplink too, and this file used
   * to spend the whole budget as though they were not — so every operating
   * point it chose was 88 kbps optimistic, and the encoder discovered the
   * shortfall by being under-served. See COMPANION_STREAMS_BPS.
   *
   * The max is defence-in-depth: `budget` is already floored at minBudgetBps
   * above, so on that path this subtraction cannot reach below minShareBps.
   */
  const shareBudget = Math.max(minShareBps(fps), budget - COMPANION_STREAMS_BPS);

  const audioBps = audioReserve(shareBudget, preset.audio.bitrate);

  // The largest picture we will send, and with it the most that can usefully be
  // spent on one. Four bounds meet here: the link's (budget), the user's
  // (preset), the receiver's (viewport), and this machine's (capacity).
  const box = resolutionBox(ceiling, viewport, fps, capacityPixelsPerSecond);

  // `bitrate: 0` means "budget decides" — clamp to the safety ceiling, never to
  // nothing. This is the line that removes the uncapped-encoder failure mode.
  const presetCeiling = preset.video.bitrate > 0 ? preset.video.bitrate : AUTO_MAX_BITRATE;
  const videoCeiling = Math.min(presetCeiling, usefulVideoBps(box, fps));
  const raw = Math.max(0, Math.min(shareBudget - audioBps, videoCeiling));

  // Quantised, so a bandwidth estimate that wanders by a few kbps every three
  // seconds does not produce a fresh setParameters + applyConstraints on every
  // poll. Encoder churn is not free, and a 25 kbps step is far below anything
  // visible.
  //
  // DOWN, not to nearest, for the reason usefulVideoBps states two functions
  // up: a floor rounds up so it stays achievable, a ceiling rounds down so it
  // stays a ceiling. `raw` is bounded by the budget, so rounding it to nearest
  // could hand out half a step more than the link was said to have — small
  // against 2 Mbps, and 12.5 of the 88 kbps this function had just been taught
  // to stop overspending. The floor below re-raises anything this pushes under
  // minVideoBps, so nothing can be quantised into an unwatchable picture.
  const quantised = Math.floor(raw / BITRATE_STEP) * BITRATE_STEP;
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
 * also bounds recovery — from the film floor to a 6 Mbps ceiling is about
 * seven probes at 1.5x, so a link that collapsed to the floor is back at its
 * ceiling in roughly a minute. The cost of overshooting is one bad ~9 s window, which
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
 * Shortest gap between two multiplicative decreases.
 *
 * A rate limit on the only branch in this reducer that COMPOUNDS. Every other
 * path is idempotent under repetition — following an estimate down is a `min`,
 * reverting a probe goes to `baseBps` exactly, raising is clamped — so calling
 * `nextBudget` twice with identical signals changes nothing anywhere else.
 * Multiply by 0.85 twice and you have 0.72, and the difference compounds every
 * poll for as long as the shortage lasts.
 *
 * That was not hypothetical. The budget effect keyed on `uplink` as well as on
 * sender health, and those are two independent three-second timers, so the
 * decrease ran about twice per observation: eleven steps across six polls in
 * the captured session, 2.0 Mbps to the floor in twenty-one seconds. The caller
 * is fixed (see SenderHealthState.tick), but a reducer whose correctness
 * depends on a dependency array is a reducer waiting for the next caller to get
 * it wrong. This makes the rate a property of the reducer instead.
 *
 * Below useSenderHealth's POLL_INTERVAL_MS of 3000 by enough that ordinary
 * timer jitter cannot swallow a legitimate step, far above the near-zero gap
 * between two effect runs in the same render pass.
 */
export const MIN_DECREASE_INTERVAL_MS = 2_500;

/**
 * What to assume a link can carry before anything has measured it.
 *
 * Two numbers, because the honest answer depends on something we DO know at
 * share time: whether this path is one whose bandwidth estimate will ever mean
 * anything. See isCapacityMeasurable — on a TURN/TCP or TURN/TLS relay it never
 * will, so `estimateBps` reaches nextBudget as null for the entire session and
 * the budget can only move by blind backoff and speculative probes.
 *
 * On such a path a generous cold start is not an optimistic guess that gets
 * corrected; it is an overshoot with no measurement able to correct it. The
 * captured session opened at 2 Mbps on a relay carrying well under one, and
 * every step after that was the loop fighting its own opening bid: overshoot,
 * standing queue in the pacer, sustained `under-served`, and a slide that only
 * stopped at the floor.
 *
 * 800 kbps is where the chooser lands on 960x540@30 at 0.040 bpp — a real
 * picture above TARGET_BPP, comfortably inside what a relayed path typically
 * carries, and that is with the camera and mic already paid for. Starting
 * there is cheap to be wrong about in the way that matters, because the
 * recovery path is the one piece of this loop that works: 1.5x per probe puts
 * it back at 2 Mbps in three probes, about half a minute, and a probe that
 * overshoots reverts exactly.
 */
export const COLD_START_BUDGET_BPS = 2_000_000;
export const RELAY_COLD_START_BUDGET_BPS = 800_000;

/**
 * The cold start for a path, given whether its estimate is worth anything.
 *
 * @param capacityMeasurable False on a TCP/TLS relay — i.e. exactly when
 *   nothing downstream will ever be able to tell us we guessed too high.
 */
export function coldStartBudgetBps(capacityMeasurable: boolean): number {
  return capacityMeasurable ? COLD_START_BUDGET_BPS : RELAY_COLD_START_BUDGET_BPS;
}

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
  capacityPixelsPerSecond: number | null = null,
  bpp = MAX_USEFUL_BPP,
): number {
  const preset = QUALITY_PRESETS[quality] ?? QUALITY_PRESETS.auto;
  const presetCeiling = preset.video.bitrate > 0 ? preset.video.bitrate : AUTO_MAX_BITRATE;
  const box = resolutionBox(quality, viewport, fps, capacityPixelsPerSecond);
  const video = Math.min(presetCeiling, usefulVideoBps(box, fps, bpp));
  // Companion streams included for the same reason chooseOperatingPoint
  // subtracts them: this is a BUDGET, and the budget pays for the whole call.
  // Without the term the budget could never climb high enough to fund `video`,
  // so the cap would sit 88 kbps below the point it exists to mark.
  return video + preset.audio.bitrate + COMPANION_STREAMS_BPS;
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
  /**
   * The receiver is being sent far less picture than it has room to draw, and
   * is NOT complaining about it.
   *
   * The other half of the viewer's report, and the half that was missing.
   * `viewerUnhappy` can only ever push the budget down; nothing the far end
   * could say was able to push it up, because `calculateQualityScore` has no
   * resolution term at all — it is a minimum over loss, jitter, RTT, frame rate
   * and freezes. A picture collapsed to 300x158 and painted into 2386x1358
   * arrives clean and smooth, scores 100, and reports 'excellent'. The sender
   * then reads that verdict as confirmation that nothing needs to change.
   *
   * So this is deliberately not folded into `viewerUnhappy`: it is not a
   * complaint and must not be answered like one. It is evidence that the
   * picture is too small, which is a reason to try SENDING MORE — see
   * `wantsMore` below, where it earns a probe that sender health alone would
   * not have asked for.
   */
  viewerStarved: boolean;
  headroom: number;
  /** Owns the frame rate, and through it the floor. */
  mode: ContentMode;
  /** The user's ceiling, and through it the cap. */
  ceiling: ScreenShareQuality;
  /** What the receiver can display, or null. Bounds the cap alongside `ceiling`. */
  viewport: Viewport | null;
  /**
   * What this machine's encoder can sustain, in pixels per second, or null.
   *
   * Here for the same reason `viewport` is: the cap has to see every bound the
   * chooser sees, or the budget spends its probe cycles climbing toward a
   * picture something else will never let it use.
   */
  capacityPixelsPerSecond: number | null;
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
  const cap = Math.max(
    floor,
    budgetCeilingBps(sig.ceiling, fps, sig.viewport, sig.capacityPixelsPerSecond),
  );
  const clamp = (bps: number) => Math.min(cap, Math.max(floor, bps));

  /*
   * Where an upward move may reach, as opposed to where the budget may sit.
   *
   * `cap` is MAX_USEFUL_BPP — the point past which more bits buy nothing — and
   * for a long time it was also the target, because both upward branches
   * clamped to it. Every share on a link with headroom therefore climbed to
   * 0.100 bpp within half a minute, three times what TARGET_BPP calls good, and
   * asked a software encoder for a bitrate that could put it over its cliff.
   * Raising stops at PROBE_CEILING_BPP now; `cap` goes back to being the clamp
   * its own comment says it is.
   */
  const raiseCap = Math.max(
    floor,
    Math.min(
      cap,
      budgetCeilingBps(
        sig.ceiling,
        fps,
        sig.viewport,
        sig.capacityPixelsPerSecond,
        PROBE_CEILING_BPP,
      ),
    ),
  );
  const raise = (bps: number) => Math.min(raiseCap, Math.max(floor, bps));

  const shortage = sig.health === 'under-served' || sig.viewerUnhappy;
  const target = sig.estimateBps === null ? null : sig.estimateBps * sig.headroom;

  // CPU pressure is not a bandwidth problem. Fewer bits do not buy the encoder
  // any CPU — but a raise we just made is the one thing that could have caused
  // it, so abandon any probe in flight and then hold.
  if (sig.health === 'cpu-bound') {
    if (!state.probing) return state;
    return { ...state, bps: clamp(state.baseBps), probing: false, lastChangeAt: sig.now };
  }

  /*
   * A still screen is not a slow link.
   *
   * This branch sits above `shortage` for the same reason `cpu-bound` does, and
   * it is the more important of the two in practice: `shortage` is an OR, and
   * its second term is the viewer's report. A viewer receiving the one frame a
   * second a motionless capture produces scores it 'critical' and says so every
   * nine seconds, forever — so without this the loop had a shortage signal that
   * could neither be satisfied nor switched off, and the budget fell 0.85× per
   * poll for as long as nobody touched the shared window. The captured session
   * did exactly that: 1.9 Mbps to 250 kbps in about forty seconds, on a path
   * measuring 4.7 Mbps.
   *
   * Holding is the entire response. Not lowering — fewer bits will not make a
   * still screen move. Not raising either: a screen producing no frames proves
   * nothing about headroom, so `satisfied` must not be inferred from the calm.
   *
   * A probe in flight is abandoned rather than judged, and WITHOUT doubling the
   * backoff, because it did not fail — it was never answerable. Reverting to
   * `baseBps` exactly is the same non-ratcheting revert the probe path uses.
   */
  if (sig.health === 'source-idle') {
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
    const multiplicative = target === null || (sig.viewerUnhappy && estimateSaysNothing);
    // The compounding path, and the only one that has to care how often it is
    // called. Following an estimate down is a `min` and repeats harmlessly; a
    // second 0.85 does not. See MIN_DECREASE_INTERVAL_MS.
    if (multiplicative && sig.now - state.lastChangeAt < MIN_DECREASE_INTERVAL_MS) return state;
    const lowered = multiplicative ? state.bps * BACKOFF_FACTOR : byEstimate;
    const bps = clamp(lowered);
    if (bps === state.bps) return state;
    return { ...state, bps, baseBps: bps, lastChangeAt: sig.now };
  }

  // New information rather than a gamble: a trusted estimate above what we are
  // spending is the link telling us directly that it has more.
  if (target !== null && target > state.bps) {
    const bps = raise(target);
    // Strictly greater, not merely different: this branch exists to raise, and
    // `raise` can return less than we are already spending when the ceiling sits
    // below the current budget. Coming down is the shortage branch's job.
    if (bps > state.bps) return { ...state, bps, baseBps: bps, lastChangeAt: sig.now };
  }

  /*
   * Room to grow, with nothing measured to justify it. Probe.
   *
   * `viewerStarved` is here rather than in `shortage` on purpose, and it is the
   * only route by which the far end can ever ask for MORE. It also covers the
   * case the two health verdicts cannot reach: a browser that publishes no
   * `targetBitrate` reads 'unknown' forever, and 'unknown' is neither a
   * shortage nor a reason to raise — so on Firefox and Safari a budget that
   * collapsed had nothing at all able to lift it while the viewer sat watching
   * a stamp. A probe is exactly the right instrument for that, because it is
   * the one move that is safe to make on no evidence: it reverts to `baseBps`
   * exactly if it fails, and its backoff doubles so a picture that genuinely
   * cannot grow stops asking.
   */
  const wantsMore =
    sig.health === 'satisfied' || sig.health === 'self-limited' || sig.viewerStarved;
  if (wantsMore && sig.now - state.lastChangeAt > state.probeBackoffMs) {
    const bps = raise(state.bps * PROBE_FACTOR);
    // Already at the ceiling. Returning here rather than marking `probing` is
    // what stops the loop stalling at the top the way it used to stall at the
    // floor: a probe that cannot move the budget has nothing to judge.
    if (bps <= state.bps) return state;
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
