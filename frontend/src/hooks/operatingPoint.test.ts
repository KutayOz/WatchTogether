import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_BITRATE,
  PROBE_INTERVAL_MS,
  PROBE_VERDICT_WINDOW_MS,
  TARGET_BPP,
  budgetCeilingBps,
  chooseOperatingPoint,
  initialBudgetState,
  minBudgetBps,
  minVideoBps,
  nextBudget,
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
    expect(point.videoBps + point.audioBps).toBeGreaterThan(1_900_000);
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
  const CAP = budgetCeilingBps('auto');

  /** Signals with everything quiet, so each test states only what it varies. */
  function sig(over: Partial<BudgetSignals> = {}): BudgetSignals {
    return {
      now: 0,
      estimateBps: null,
      health: 'unknown',
      viewerUnhappy: false,
      headroom: H,
      mode: 'film',
      ceiling: 'auto',
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

  it('climbs when the link proves it has more', () => {
    const state = nextBudget(
      initialBudgetState(1_000_000, 0),
      sig({ now: 3000, estimateBps: 4_000_000 }),
    );
    expect(state.bps).toBe(3_400_000);
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
