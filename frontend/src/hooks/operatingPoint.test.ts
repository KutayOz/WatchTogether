import { describe, expect, it } from 'vitest';
import { QUALITY_PRESETS } from '../types';
import {
  AUTO_MAX_BITRATE,
  BACKOFF_FACTOR,
  COMPANION_STREAMS_BPS,
  COLD_START_BUDGET_BPS,
  MIN_DECREASE_INTERVAL_MS,
  PROBE_INTERVAL_MS,
  PROBE_VERDICT_WINDOW_MS,
  RELAY_COLD_START_BUDGET_BPS,
  TARGET_BPP,
  MAX_USEFUL_BPP,
  PROBE_CEILING_BPP,
  budgetCeilingBps,
  chooseOperatingPoint,
  coldStartBudgetBps,
  resolutionBox,
  initialBudgetState,
  minBudgetBps,
  minVideoBps,
  nextBudget,
  usefulVideoBps,
  type BudgetSignals,
} from './operatingPoint';

/**
 * The optimization this whole change exists for.
 *
 * The old ladder had six fixed rungs with a hole between 1.5 and 4 Mbps, so a
 * 2 Mbps link ran 720p and left a third of its uplink unused — and a link below
 * 2 Mbps could afford no rung at all and fell through to `auto`, which set no
 * encoder ceiling whatsoever.
 */

describe('chooseOperatingPoint', () => {
  it('sits on the convex hull for film content', () => {
    // Budgets chosen so the video share after the audio reserve is ~2.2 / 1.6 /
    // 1.0 / 0.6 Mbps. At 24 fps those are the crossover points where the next
    // resolution up would fall below TARGET_BPP.
    const at = (budget: number) => chooseOperatingPoint(budget, 'film');

    expect(at(2_300_000)).toMatchObject({ width: 1920, height: 1080, fps: 24 });
    expect(at(1_700_000)).toMatchObject({ width: 1600, height: 900, fps: 24 });
    expect(at(1_080_000)).toMatchObject({ width: 1280, height: 720, fps: 24 });
    expect(at(660_000)).toMatchObject({ width: 960, height: 540, fps: 24 });
  });

  it('clears the bpp target whenever the budget allows it at all', () => {
    for (const budget of [700_000, 1_000_000, 1_500_000, 2_000_000, 3_000_000, 5_000_000]) {
      const point = chooseOperatingPoint(budget, 'film');
      expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
    }
  });

  it('never returns a smaller picture for a larger budget', () => {
    // Monotonicity. Without it the controller could oscillate between two
    // points on a link whose estimate wanders by a few percent.
    let previous = 0;
    for (let budget = 300_000; budget <= 8_000_000; budget += 100_000) {
      const point = chooseOperatingPoint(budget, 'motion');
      const pixels = point.width * point.height;
      expect(pixels).toBeGreaterThanOrEqual(previous);
      previous = pixels;
    }
  });

  it('spends a 2 Mbps link on 1080p rather than leaving it unused', () => {
    // The regression that motivated the change: the old ladder answered `low`
    // (720p, 1.5 Mbps) here and left the rest of the link on the table.
    const point = chooseOperatingPoint(2_000_000, 'film');
    expect(point.height).toBeGreaterThanOrEqual(900);
    // Measured across the whole budget, because the share is not the only thing
    // the budget pays for. The camera thumbnail and the mic take 88 kbps of
    // this and always did — the difference is that the number now says so.
    expect(point.videoBps + point.audioBps + COMPANION_STREAMS_BPS).toBeGreaterThan(1_900_000);
  });

  it('gives auto a finite ceiling instead of an unbounded encoder', () => {
    // `bitrate: 0` used to mean `delete enc.maxBitrate`. On a slow link that is
    // the worst state in the system: overshoot, standing queue, soft AND laggy.
    const huge = chooseOperatingPoint(50_000_000, 'games', 'auto');
    expect(Number.isFinite(huge.videoBps)).toBe(true);
    expect(huge.videoBps).toBeLessThanOrEqual(AUTO_MAX_BITRATE);
  });

  it('treats the selected preset as a ceiling, never a target', () => {
    // Plenty of budget, but `low` means "never past 720p / 1.5 Mbps".
    const capped = chooseOperatingPoint(10_000_000, 'motion', 'low');
    expect(capped.width).toBeLessThanOrEqual(1280);
    expect(capped.height).toBeLessThanOrEqual(720);
    expect(capped.videoBps).toBeLessThanOrEqual(1_500_000);

    // And it must not inflate a small budget up to the ceiling either.
    const small = chooseOperatingPoint(800_000, 'motion', 'extreme');
    expect(small.videoBps).toBeLessThan(800_000);
  });

  it('buys sharpness with frame rate on film content', () => {
    // The free lever: 24 fps source encoded at 30 divides the same budget over
    // 25% more frames. At identical bitrate, film must beat motion on bpp.
    const budget = 2_000_000;
    const film = chooseOperatingPoint(budget, 'film');
    const motion = chooseOperatingPoint(budget, 'motion');

    expect(film.fps).toBe(24);
    expect(motion.fps).toBe(30);
    // Same picture size, more bits per frame — or a larger picture at the same
    // bpp. Either way film is never the worse point.
    expect(film.width * film.height * film.bpp).toBeGreaterThanOrEqual(
      motion.width * motion.height * motion.bpp * 0.999,
    );
  });

  it('asks for 60 fps in games mode', () => {
    expect(chooseOperatingPoint(8_000_000, 'games', 'high').fps).toBe(60);
  });

  it('degrades to the smallest allowed picture rather than a smeared large one', () => {
    // A genuinely unusable link. The contract is that it still returns
    // something sane instead of throwing or picking 4K at 0.001 bpp.
    const point = chooseOperatingPoint(120_000, 'film');
    expect(point).toMatchObject({ width: 640, height: 360, fps: 24, videoBps: 200_000 });
    expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
  });

  it('never asks the encoder for a picture it cannot run', () => {
    // The bug this floor exists for. A relayed TURN/TCP session whose estimate
    // had collapsed to its own ask drove the budget to ~25 kbps; this function
    // asked for 854x480 at 24 fps on 25 kbps (0.0025 bpp) and Chrome answered
    // with 344x182 at 1 fps — smaller than any rung we offer.
    for (const budget of [0, 25_000, 89_000, 120_000, 264_000]) {
      for (const mode of ['film', 'motion', 'games'] as const) {
        const point = chooseOperatingPoint(budget, mode);
        expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
        expect(point.videoBps).toBeGreaterThanOrEqual(minVideoBps(point.fps));
      }
    }
  });

  it('floors the budget before audio takes its cut', () => {
    // A flat 64 kbps reserve is 64% of a collapsed 100 kbps budget. Flooring
    // first is what stops audio starving the video encoder.
    const point = chooseOperatingPoint(100_000, 'film');
    expect(point.audioBps / (point.videoBps + point.audioBps)).toBeLessThanOrEqual(0.25);
  });

  it('puts the floor exactly at the smallest rung hitting target bpp', () => {
    // minBudgetBps is not a chosen number — it is the budget at which the
    // smallest rung we allow reaches TARGET_BPP. Verify that, per mode.
    for (const [mode, fps] of [['film', 24], ['motion', 30], ['games', 60]] as const) {
      const point = chooseOperatingPoint(minBudgetBps(fps), mode);
      expect(point).toMatchObject({ width: 640, height: 360, fps });
      expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
    }
  });

  it('reserves less for audio on a small budget than a large one', () => {
    // A flat 128 kbps is 13% of a 1 Mbps budget and 3% of a 4 Mbps one.
    const small = chooseOperatingPoint(900_000, 'film', 'high');
    const large = chooseOperatingPoint(4_000_000, 'film', 'high');
    expect(small.audioBps).toBeLessThan(large.audioBps);
  });
});

/**
 * The two feedback traps, which pull in opposite directions.
 *
 * availableOutgoingBitrate is bounded by what we are already sending. Spend
 * `estimate * 0.85` every tick and the next estimate is ~85% of this one: no
 * single step is wrong and the stream walks to the floor. But a budget that
 * only ever FOLLOWS that estimate can never rise either, because the estimate
 * cannot rise until we send more. The reported session sat at 30 kbps between
 * a 200 Mbps link and a 30 Mbps one with nothing able to propose sending more.
 */
describe('nextBudget', () => {
  const H = 0.85;
  const FLOOR = minBudgetBps(24); // film
  const CAP = budgetCeilingBps('auto', 24, null);

  /** Signals with everything quiet, so each test states only what it varies. */
  function sig(over: Partial<BudgetSignals> = {}): BudgetSignals {
    return {
      now: 0,
      estimateBps: null,
      health: 'unknown',
      viewerUnhappy: false,
      viewerStarved: false,
      headroom: H,
      mode: 'film',
      ceiling: 'auto',
      viewport: null,
      capacityPixelsPerSecond: null,
      ...over,
    };
  }

  it('does not decay when the link is meeting the ask', () => {
    // We spend 2.55 Mbps of a 3 Mbps estimate; the estimator then reports 2.6
    // because that is roughly what we are sending. The budget must not follow.
    let state = initialBudgetState(2_550_000, 0);
    for (let i = 1; i <= 20; i++) {
      state = nextBudget(state, sig({ now: i * 3000, estimateBps: 2_600_000 }));
    }
    expect(state.bps).toBe(2_550_000);
  });

  it('follows a trusted estimate down when the encoder is genuinely under-served', () => {
    const state = nextBudget(
      initialBudgetState(2_550_000, 0),
      sig({ now: 3000, estimateBps: 1_200_000, health: 'under-served' }),
    );
    expect(state.bps).toBe(1_020_000);
  });

  it('climbs when the link proves it has more, but only as far as it is worth', () => {
    // 4 Mbps of measured capacity times HEADROOM_SELECT would be 3.4 Mbps, and
    // that is what this used to become. Raising now stops at PROBE_CEILING_BPP:
    // 0.05 x 1920 x 1080 x 24 = 2.488 Mbps of video, quantised down, plus the
    // 96 kbps audio tier and the camera and mic the same uplink is carrying.
    // The link having more is not by itself a reason to spend more on a picture
    // that is already past the point of visible return.
    const state = nextBudget(
      initialBudgetState(1_000_000, 0),
      sig({ now: 3000, estimateBps: 4_000_000 }),
    );
    expect(state.bps).toBe(2_475_000 + 96_000 + COMPANION_STREAMS_BPS);
    expect(state.bps).toBeLessThan(3_400_000);
  });

  it('stops the climb at 1.4x TARGET_BPP rather than 3x', () => {
    // The failure this guards: `budgetCeilingBps` was built from MAX_USEFUL_BPP
    // and both upward branches clamped to it, so within about thirty seconds
    // every share on a link with headroom settled at 0.100 bpp — three times
    // what TARGET_BPP calls good — and asked a software encoder for a bitrate
    // that could put it over its cliff. MAX_USEFUL_BPP's own comment says
    // "Nothing is ever raised TO it"; this is the test that makes that true.
    let state = initialBudgetState(minBudgetBps(24), 0);
    for (let i = 1; i <= 40; i++) {
      state = nextBudget(state, sig({ now: i * PROBE_INTERVAL_MS * 2, health: 'satisfied' }));
    }
    const point = chooseOperatingPoint(state.bps, 'film');
    expect(point.bpp).toBeGreaterThan(TARGET_BPP);
    expect(point.bpp).toBeLessThanOrEqual(PROBE_CEILING_BPP);
    expect(point.bpp).toBeLessThan(MAX_USEFUL_BPP);
  });

  it('holds steady when the browser publishes no estimate', () => {
    // Firefox. No opinion is never, by itself, a reason to move anything.
    const held = nextBudget(initialBudgetState(2_000_000, 0), sig({ now: 3000 }));
    expect(held.bps).toBe(2_000_000);
  });

  it('backs off without an estimate when the encoder says it is short', () => {
    // No number to follow down, but "under-served" is itself evidence. Standing
    // still while the picture breaks is not a neutral choice.
    const state = nextBudget(
      initialBudgetState(2_000_000, 0),
      sig({ now: 3000, health: 'under-served' }),
    );
    expect(state.bps).toBe(1_700_000);
  });

  it('never ratchets below the true capacity across a noisy run', () => {
    let state = initialBudgetState(2_550_000, 0);
    const samples = [2_900_000, 2_600_000, 3_100_000, 2_700_000, 2_950_000];
    samples.forEach((estimateBps, i) => {
      state = nextBudget(state, sig({ now: (i + 1) * 3000, estimateBps }));
    });
    expect(state.bps).toBeGreaterThanOrEqual(2_550_000);
  });

  it('never goes below the floor, however bogus the estimate', () => {
    // 50 polls of a 30 kbps reading with the encoder reporting shortage. The
    // old code had no floor at all and quantised its way to 25 kbps.
    let state = initialBudgetState(2_000_000, 0);
    for (let i = 1; i <= 50; i++) {
      state = nextBudget(
        state,
        sig({ now: i * 3000, estimateBps: 30_000, health: 'under-served' }),
      );
    }
    expect(state.bps).toBe(FLOOR);
  });

  it('raises the budget when the encoder says our own ceiling is the constraint', () => {
    // 'self-limited' is the verdict the reported collapse actually sat in, and
    // the classifier used to answer 'unknown' — which froze this function.
    let state = initialBudgetState(FLOOR, 0);
    state = nextBudget(state, sig({ now: 20_000, health: 'self-limited' }));
    expect(state.bps).toBeGreaterThan(FLOOR);
    expect(state.probing).toBe(true);
  });

  it('a hundred failed probes leave the budget where they found it', () => {
    // The ratchet property, stated directly. A probe that fails must revert to
    // baseBps EXACTLY — reverting by a factor is how repeated failure decays.
    let state = initialBudgetState(1_000_000, 0);
    let now = 0;
    for (let i = 0; i < 100; i++) {
      now += 200_000; // always past the backoff, however far it has doubled
      state = nextBudget(state, sig({ now, health: 'satisfied' }));
      now += 3000;
      state = nextBudget(state, sig({ now, health: 'under-served' }));
    }
    expect(state.bps).toBe(1_000_000);
  });

  it('doubles the wait after a failed probe and resets it after a proven one', () => {
    let state = initialBudgetState(1_000_000, 0);
    state = nextBudget(state, sig({ now: 20_000, health: 'satisfied' }));
    expect(state.probing).toBe(true);

    const failed = nextBudget(state, sig({ now: 23_000, health: 'under-served' }));
    expect(failed.probeBackoffMs).toBe(PROBE_INTERVAL_MS * 2);
    expect(failed.bps).toBe(1_000_000);

    // A probe left alone past the verdict window is banked, and the doubling
    // undone — otherwise one early failure slows every later recovery forever.
    let again = nextBudget(failed, sig({ now: 250_000, health: 'satisfied' }));
    again = nextBudget(again, sig({ now: 250_000 + PROBE_VERDICT_WINDOW_MS + 1, health: 'satisfied' }));
    expect(again.probeBackoffMs).toBe(PROBE_INTERVAL_MS);
    expect(again.probing).toBe(false);
    expect(again.baseBps).toBe(again.bps);
  });

  it('at the cap, a probe is a no-op and does not mark the budget as probing', () => {
    // Otherwise the loop stalls at the top the way it used to stall at the floor.
    const state = nextBudget(
      initialBudgetState(CAP, 0),
      sig({ now: 60_000, health: 'satisfied' }),
    );
    expect(state.bps).toBe(CAP);
    expect(state.probing).toBe(false);
  });

  it('holds on cpu-bound and abandons the probe in flight', () => {
    // Fewer bits do not buy CPU — but the raise we just made could have caused it.
    let state = initialBudgetState(1_000_000, 0);
    state = nextBudget(state, sig({ now: 20_000, health: 'satisfied' }));
    expect(state.bps).toBeGreaterThan(1_000_000);

    state = nextBudget(state, sig({ now: 23_000, health: 'cpu-bound' }));
    expect(state.bps).toBe(1_000_000);
    expect(state.probing).toBe(false);
  });

  it('lets the viewer lower the budget on auto, where the ladder is inert', () => {
    // `auto` is not a rung on QUALITY_LADDER, so nextLadderState cannot act on
    // viewer feedback at all. This reducer is its only route in.
    const state = nextBudget(
      initialBudgetState(2_000_000, 0),
      sig({ now: 3000, viewerUnhappy: true }),
    );
    expect(state.bps).toBeLessThan(2_000_000);
  });

  it('recovers from the reported collapse within about two minutes', () => {
    /*
     * The regression test for the whole change. Replays the session:
     *
     *   path: relayed (turn/tcp) · 231 ms
     *   sending: 344x182 @ 1 · 0.03 Mbps
     *   limited by: bandwidth
     *
     * The estimate is pinned at 30 kbps and untrusted (TCP relay), so it
     * arrives here as null. The encoder reports 'self-limited': it is getting
     * everything we ask for and is still degraded, because OUR ceiling is what
     * binds. Nothing in the old design could act on that.
     */
    let state = initialBudgetState(FLOOR, 0);
    let polls = 0;
    for (let now = 3000; now <= 40 * 3000; now += 3000) {
      polls++;
      state = nextBudget(state, sig({ now, estimateBps: null, health: 'self-limited' }));
      if (state.bps >= 2_000_000) break;
    }

    expect(state.bps).toBeGreaterThanOrEqual(2_000_000);
    expect(polls).toBeLessThanOrEqual(40); // 40 polls x 3 s = two minutes
  });
});

/**
 * The top end.
 *
 * The floor work made a bad link watchable. This is the other half of the same
 * requirement — a good link reaching what it can actually carry — and it was
 * blocked by `auto` being boxed at 1080p on a 6 Mbps cap that could not have
 * funded 4K even if the box had allowed it (4K24 needs 6.97 Mbps merely to
 * reach TARGET_BPP).
 */
describe('resolutionBox', () => {
  it('holds auto at 1080p when the receiver has said nothing', () => {
    expect(resolutionBox('auto', null)).toEqual({ width: 1920, height: 1080 });
  });

  it('lets auto past 1080p once the receiver reports a screen that large', () => {
    expect(resolutionBox('auto', { width: 3840, height: 2160 })).toEqual({
      width: 3840,
      height: 2160,
    });
  });

  it('follows the receiver down to a small window', () => {
    expect(resolutionBox('auto', { width: 1280, height: 720 })).toEqual({
      width: 1280,
      height: 720,
    });
  });

  it('does not narrow an explicit pick just because nothing was reported', () => {
    // An explicit choice is a statement of intent — the same principle
    // withUserChoice encodes. A peer on an older build sends no viewport, and
    // that must not quietly demote someone who deliberately chose Ultra.
    expect(resolutionBox('ultra', null)).toEqual({ width: 3840, height: 2160 });
  });
});

describe('chooseOperatingPoint and the receiver', () => {
  it('reaches 4K on a fast link once the receiver reports a 4K viewport', () => {
    const point = chooseOperatingPoint(10_000_000, 'film', 'auto', {
      width: 3840,
      height: 2160,
    });
    expect(point.width).toBe(3840);
    expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
  });

  it('still stops at 1080p on the same link when the receiver has said nothing', () => {
    const point = chooseOperatingPoint(10_000_000, 'film', 'auto', null);
    expect(point.width).toBe(1920);
  });

  it('does not pour a fast link into a small window', () => {
    // 720p at 10 Mbps would be 0.45 bpp: bits with nowhere to land, taken from
    // a connection the viewer is also using for everything else.
    const point = chooseOperatingPoint(10_000_000, 'film', 'auto', {
      width: 1280,
      height: 720,
    });
    expect(point.width).toBe(1280);
    expect(point.bpp).toBeLessThanOrEqual(MAX_USEFUL_BPP);
  });

  it('keeps the floor even when the viewport is smaller than the smallest rung', () => {
    // A thumbnail-sized element must not push the bitrate under the floor the
    // rest of this file exists to defend.
    const point = chooseOperatingPoint(300_000, 'film', 'auto', { width: 320, height: 180 });
    expect(point.videoBps).toBeGreaterThanOrEqual(minVideoBps(24));
  });
});

describe('budgetCeilingBps and the receiver', () => {
  it('stops the budget climbing past what the viewport can use', () => {
    // Without this the budget would probe upward forever against an encoder
    // configuration that cannot change — every cycle spent learning nothing.
    const small = budgetCeilingBps('auto', 24, { width: 1280, height: 720 });
    const large = budgetCeilingBps('auto', 24, { width: 3840, height: 2160 });
    expect(small).toBeLessThan(large);
    // Video ceiling, the audio tier, and the rest of the call — a budget number
    // has to cover everything the budget pays for.
    expect(large).toBe(AUTO_MAX_BITRATE + 96_000 + COMPANION_STREAMS_BPS);
  });
});

describe('chooseOperatingPoint and the encoder it has to run on', () => {
  it('is unchanged when the machine has no opinion about itself', () => {
    // Every existing caller passed nothing here, and null has to mean exactly
    // what it meant before this bound existed.
    const withNull = chooseOperatingPoint(2_571_000, 'film', 'auto', null, null);
    const without = chooseOperatingPoint(2_571_000, 'film', 'auto', null);
    expect(withNull).toEqual(without);
  });

  it('will not ask for more pixels per second than the encoder has shown it can do', () => {
    // 1080p24 is 49.8 Mpx/s. A machine that has proven 30 gets 1280x720, which
    // is 22.1 — the largest rung that fits, not the closest.
    const point = chooseOperatingPoint(2_571_000, 'film', 'auto', null, 30_000_000);
    expect(point.width * point.height * point.fps).toBeLessThanOrEqual(30_000_000);
    expect(point.width).toBe(1280);
  });

  it('takes pixels rather than bits, so the smaller picture looks sharper', () => {
    // The reason this is a pixel bound and not a bitrate one. `SenderHealth`
    // is explicit that a CPU limit "MUST NOT be answered by lowering the
    // bitrate: fewer bits do not buy CPU". Fewer pixels do — and the bits stay
    // where the budget put them, so bits-per-pixel goes UP.
    //
    // The bitrate is untouched HERE because the budget, not MAX_USEFUL_BPP, is
    // still the binding constraint at this box. A much deeper cut would lower
    // it too, and correctly so: that is `usefulVideoBps` declining to spend
    // bits a small picture has nowhere to put, which is a different rule.
    const free = chooseOperatingPoint(2_571_000, 'film');
    const bound = chooseOperatingPoint(2_571_000, 'film', 'auto', null, 30_000_000);
    expect(bound.videoBps).toBe(free.videoBps);
    expect(bound.bpp).toBeGreaterThan(free.bpp);
  });

  it('trades resolution for frame rate under one bound', () => {
    // The same machine asked for 60 fps content gets a much smaller picture,
    // which is the trade the content mode is already making elsewhere.
    const film = chooseOperatingPoint(4_000_000, 'film', 'auto', null, 30_000_000);
    const games = chooseOperatingPoint(4_000_000, 'games', 'auto', null, 30_000_000);
    expect(games.width).toBeLessThan(film.width);
  });

  it('keeps the floor even when the bound is below every rung', () => {
    // Unwatchable is worse than wasteful — the precedence usefulVideoBps
    // already settled for the viewport bound applies here too.
    const point = chooseOperatingPoint(2_571_000, 'film', 'auto', null, 1_000);
    expect(point.width).toBe(640);
    expect(point.height).toBe(360);
  });

  it('stops the budget climbing toward a picture the encoder will not run', () => {
    // Without this the budget burns every probe cycle learning nothing: the
    // clamp would catch it in the end, but the ceiling has to see every bound
    // the chooser sees. Same argument the viewport term already carries.
    const free = budgetCeilingBps('auto', 24, null, null);
    const bound = budgetCeilingBps('auto', 24, null, 30_000_000);
    expect(bound).toBeLessThan(free);
  });
});

describe('nextBudget and a still screen', () => {
  /** Signals with everything quiet, so each test states only what it varies. */
  function sig(over: Partial<BudgetSignals> = {}): BudgetSignals {
    return {
      now: 0,
      estimateBps: null,
      health: 'unknown',
      viewerUnhappy: false,
      viewerStarved: false,
      headroom: 0.85,
      mode: 'motion',
      ceiling: 'auto',
      viewport: null,
      capacityPixelsPerSecond: null,
      ...over,
    };
  }

  it('does not answer a motionless capture by cutting the budget', () => {
    // The captured failure, reproduced. A viewer receiving the one frame a
    // second a still window produces scores it 'critical' and says so every
    // nine seconds — forever, because nothing the budget does can make a
    // paused video move. Thirteen polls of that walked 1.9 Mbps to 250 kbps on
    // a path measuring 4.7.
    let state = initialBudgetState(1_900_000, 0);
    for (let i = 1; i <= 20; i++) {
      state = nextBudget(
        state,
        sig({ now: i * 3000, health: 'source-idle', viewerUnhappy: true }),
      );
    }
    expect(state.bps).toBe(1_900_000);
  });

  it('proves the same signals without the verdict do cut it', () => {
    // The companion to the test above: without 'source-idle' this is the
    // shortage path, and it is supposed to be. The fix is the verdict, not a
    // weakening of the response to a real shortage.
    let state = initialBudgetState(1_900_000, 0);
    for (let i = 1; i <= 20; i++) {
      state = nextBudget(state, sig({ now: i * 3000, viewerUnhappy: true }));
    }
    // All the way to the floor. Stated as the floor rather than as a literal
    // below it, so counting a new cost into the budget moves the assertion
    // with the thing it is asserting about.
    expect(state.bps).toBe(minBudgetBps(30));
  });

  it('does not climb on the quiet either', () => {
    // A screen producing no frames is no evidence of headroom. Holding has to
    // mean holding in both directions or the budget would probe its way up
    // during the calm and then meet the resumed video over-committed.
    const start = initialBudgetState(1_000_000, 0);
    let state = start;
    for (let i = 1; i <= 20; i++) {
      state = nextBudget(state, sig({ now: i * 3000, health: 'source-idle' }));
    }
    expect(state.bps).toBe(1_000_000);
    expect(state.probing).toBe(false);
  });

  it('abandons a probe in flight without charging it as a failure', () => {
    // The probe was never answerable — the screen stopped moving before a
    // verdict could form — so it reverts to the proven value exactly and the
    // backoff stays where it was. Doubling it would punish a probe that never
    // got its question asked.
    let state = initialBudgetState(1_000_000, 0);
    state = nextBudget(state, sig({ now: 30_000, health: 'satisfied' }));
    expect(state.probing).toBe(true);
    const probeBackoffMs = state.probeBackoffMs;

    state = nextBudget(state, sig({ now: 33_000, health: 'source-idle' }));
    expect(state.probing).toBe(false);
    expect(state.bps).toBe(1_000_000);
    expect(state.probeBackoffMs).toBe(probeBackoffMs);
  });
});


/**
 * The collapse in the captured session, and the two properties that stop it.
 *
 * A TURN/TCP relay reports `capacityKnown: false` forever, so `estimateBps`
 * reaches this reducer as null for the whole share and the multiplicative
 * decrease is the ONLY way down. That path compounds, which makes how often it
 * is called part of its behaviour — and it was being called about twice per
 * observation, because the effect driving it listed the uplink estimate (a
 * separate three-second timer) alongside sender health.
 */
describe('nextBudget under a shortage with no trusted estimate', () => {
  const POLL_MS = 3_000;

  function sig(over: Partial<BudgetSignals> = {}): BudgetSignals {
    return {
      now: 0,
      estimateBps: null,
      health: 'under-served',
      viewerUnhappy: false,
      viewerStarved: false,
      headroom: 0.85,
      mode: 'motion',
      ceiling: 'medium',
      viewport: null,
      capacityPixelsPerSecond: null,
      ...over,
    };
  }

  it('backs off exactly once per poll, however often it is called', () => {
    // The captured session's opening numbers: 2 Mbps, motion, medium.
    const start = initialBudgetState(2_000_000, 0);

    const once = nextBudget(start, sig({ now: POLL_MS }));
    expect(once.bps).toBeCloseTo(2_000_000 * BACKOFF_FACTOR, 0);

    // A second call inside the same observation — the uplink poller firing the
    // same effect a few hundred milliseconds later. It must change nothing.
    const twice = nextBudget(once, sig({ now: POLL_MS + 400 }));
    expect(twice).toBe(once);
    expect(twice.bps).toBeCloseTo(2_000_000 * BACKOFF_FACTOR, 0);
  });

  it('descends at 0.85 per poll, not 0.72', () => {
    // The tell in the report that identified this: consecutive budget samples
    // three seconds apart sat at ratios of 0.72, which is BACKOFF_FACTOR
    // squared. Eleven encoder steps across six polls.
    let state = initialBudgetState(2_000_000, 0);
    const seen: number[] = [];
    // Two calls per poll, as the two independent timers produced.
    for (let now = POLL_MS; now <= POLL_MS * 5; now += POLL_MS) {
      state = nextBudget(state, sig({ now }));
      state = nextBudget(state, sig({ now: now + 500 }));
      seen.push(state.bps);
    }
    for (let i = 1; i < seen.length; i++) {
      expect(seen[i] / seen[i - 1]).toBeCloseTo(BACKOFF_FACTOR, 3);
    }
  });

  it('still lets a genuine shortage move on the very next poll', () => {
    // The gate is a rate limit, not a cooldown: it must be strictly shorter
    // than one poll or the descent halves and a link in real trouble waits.
    expect(MIN_DECREASE_INTERVAL_MS).toBeLessThan(POLL_MS);
  });

  it('does not gate the exact revert of a failed probe', () => {
    // Reverting goes to `baseBps` and cannot compound, so it must not be
    // delayed — that is the property that makes probing safe to try at all.
    const probing = { ...initialBudgetState(1_000_000, 0), bps: 1_500_000, probing: true };
    const after = nextBudget(probing, sig({ now: 100 }));
    expect(after.bps).toBe(1_000_000);
    expect(after.probing).toBe(false);
  });
});

/**
 * Where to start on a path whose estimate will never mean anything.
 *
 * The captured collapse opened at 2 Mbps on a relay carrying well under one,
 * and there was no measurement anywhere in the system able to say so: on a
 * TCP/TLS relay `isCapacityMeasurable` is false for the life of the connection.
 * An overshoot that cannot be corrected has to be avoided instead.
 */
describe('coldStartBudgetBps', () => {
  it('opens lower where nothing can ever say the opening bid was too high', () => {
    expect(coldStartBudgetBps(false)).toBe(RELAY_COLD_START_BUDGET_BPS);
    expect(coldStartBudgetBps(false)).toBeLessThan(coldStartBudgetBps(true));
  });

  it('leaves a measurable path exactly as it was', () => {
    expect(coldStartBudgetBps(true)).toBe(COLD_START_BUDGET_BPS);
  });

  it('still opens on a real picture, not a placeholder', () => {
    // Starting low is only safe if low is watchable. 960x540 at target bpp is
    // a picture; the probe ladder does the rest.
    const point = chooseOperatingPoint(coldStartBudgetBps(false), 'motion', 'medium');
    expect(point.width).toBe(960);
    expect(point.height).toBe(540);
    expect(point.bpp).toBeGreaterThanOrEqual(TARGET_BPP);
  });

  it('climbs back to the generous start within a few probes', () => {
    // The cost of guessing low is bounded by how fast probing undoes it.
    let state = initialBudgetState(RELAY_COLD_START_BUDGET_BPS, 0);
    let now = 0;
    let probes = 0;
    while (state.bps < COLD_START_BUDGET_BPS && probes < 10) {
      now += PROBE_INTERVAL_MS + 1;
      state = nextBudget(state, {
        now,
        estimateBps: null,
        health: 'self-limited',
        viewerUnhappy: false,
        viewerStarved: false,
        headroom: 0.85,
        mode: 'motion',
        ceiling: 'medium',
        viewport: { width: 1920, height: 1080 },
        capacityPixelsPerSecond: null,
      });
      // Bank it, the way a probe that draws no complaint is banked.
      state = { ...state, baseBps: state.bps, probing: false };
      probes++;
    }
    expect(state.bps).toBeGreaterThanOrEqual(COLD_START_BUDGET_BPS);
    expect(probes).toBeLessThanOrEqual(4);
  });
});

/**
 * The receiver asking for MORE, which it could never do before.
 *
 * calculateQualityScore is a minimum over loss, jitter, RTT, frame rate and
 * freezes — no term in it is a function of how many pixels arrived. A picture
 * collapsed to 300x158 and painted into 2386x1358 scores 100 and reports
 * 'excellent', so the only viewer signal the budget had said "everything is
 * fine" at the exact moment the picture was unusable.
 */
describe('nextBudget and a starved viewer', () => {
  function sig(over: Partial<BudgetSignals> = {}): BudgetSignals {
    return {
      now: PROBE_INTERVAL_MS + 1,
      estimateBps: null,
      health: 'unknown',
      viewerUnhappy: false,
      viewerStarved: false,
      headroom: 0.85,
      mode: 'motion',
      ceiling: 'medium',
      viewport: { width: 2386, height: 1358 },
      capacityPixelsPerSecond: null,
      ...over,
    };
  }

  it('probes upward on a verdict sender health cannot reach', () => {
    // 'unknown' is neither `shortage` nor `wantsMore`, so this state was
    // completely inert — and it is where Firefox and Safari live permanently,
    // since neither publishes targetBitrate.
    const start = initialBudgetState(400_000, 0);
    expect(nextBudget(start, sig())).toBe(start);

    const probed = nextBudget(start, sig({ viewerStarved: true }));
    expect(probed.bps).toBeGreaterThan(start.bps);
    expect(probed.probing).toBe(true);
    // The revert target is untouched, so a failed probe costs nothing.
    expect(probed.baseBps).toBe(start.bps);
  });

  it('does not turn a small picture into a reason to send even less', () => {
    // The signal is deliberately not folded into `viewerUnhappy`: answering
    // "too small" with a back-off is the wrong direction, and it is the
    // direction the loop was already stuck in.
    const start = initialBudgetState(400_000, 0);
    const after = nextBudget(start, sig({ viewerStarved: true }));
    expect(after.bps).toBeGreaterThanOrEqual(start.bps);
  });

  it('still lets a genuine shortage win', () => {
    // Both true at once is a link in trouble, and shortage is read first.
    const start = initialBudgetState(1_000_000, 0);
    const after = nextBudget(
      start,
      sig({ health: 'under-served', viewerStarved: true, now: 3_000 }),
    );
    expect(after.bps).toBeLessThan(start.bps);
  });
});


/**
 * The share is not alone on the wire.
 *
 * `budgetBps` is documented as the total available, and for a long time this
 * file spent all of it on the share while `applyCameraEncoding` and the mic
 * took another 88 kbps off the same uplink — so every point it chose was 88
 * kbps optimistic and the encoder found out by being under-served. On a
 * floor-level budget that is 27% unaccounted, and on a TCP-relayed path there
 * is no HEADROOM_SELECT discount absorbing it either, because `estimateBps`
 * arrives null and nothing gets multiplied.
 */
describe('chooseOperatingPoint and the rest of the call', () => {
  const modes = [
    { mode: 'film', fps: 24 },
    { mode: 'motion', fps: 30 },
    { mode: 'games', fps: 60 },
  ] as const;

  it('never asks for more than the budget, companion streams included', () => {
    for (const { mode } of modes) {
      for (const budget of [400_000, 800_000, 1_500_000, 2_000_000, 4_000_000]) {
        const point = chooseOperatingPoint(budget, mode, 'medium', { width: 1920, height: 1080 });
        const asked = point.videoBps + point.audioBps + COMPANION_STREAMS_BPS;
        // At or below the floor the over-subscription is deliberate and
        // documented; above it the sum has to fit.
        if (budget >= minBudgetBps(point.fps)) {
          expect(asked).toBeLessThanOrEqual(budget);
        }
      }
    }
  });

  it('makes minBudgetBps mean what its name says', () => {
    // It did not: it returned the SHARE's floor, so a budget of exactly this
    // much left the encoder 88 kbps short of minVideoBps.
    for (const { mode, fps } of modes) {
      const point = chooseOperatingPoint(minBudgetBps(fps), mode, 'auto');
      expect(point.videoBps).toBe(minVideoBps(fps));
      expect(point.videoBps + point.audioBps + COMPANION_STREAMS_BPS).toBe(minBudgetBps(fps));
    }
  });

  it('still defends the video floor below it, over-subscribing on purpose', () => {
    // Unwatchable is worse than wasteful, and the pacer adapts underneath us.
    const point = chooseOperatingPoint(100_000, 'motion', 'auto');
    expect(point.videoBps).toBe(minVideoBps(30));
  });

  it('leaves a budget with real headroom picking the same picture as before', () => {
    // The correction is 88 kbps. It has to matter at the floor and be invisible
    // at the top, or it is a quality regression dressed as an accounting fix.
    const point = chooseOperatingPoint(4_000_000, 'film', 'medium', { width: 1920, height: 1080 });
    expect(point.width).toBe(1920);
    expect(point.height).toBe(1080);
  });

  it('keeps budgetCeilingBps the budget at which the ceiling is reachable', () => {
    // The cap and the chooser have to agree, or the budget probes toward a
    // video bitrate it can never actually be given.
    const viewport = { width: 1920, height: 1080 };
    const cap = budgetCeilingBps('medium', 24, viewport);
    const point = chooseOperatingPoint(cap, 'film', 'medium', viewport);
    expect(point.videoBps).toBe(
      Math.min(QUALITY_PRESETS.medium.video.bitrate, usefulVideoBps(viewport, 24)),
    );
  });
});
