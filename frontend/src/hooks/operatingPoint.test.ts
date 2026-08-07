import { describe, expect, it } from 'vitest';
import {
  AUTO_MAX_BITRATE,
  TARGET_BPP,
  chooseOperatingPoint,
  nextBudget,
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
    expect(point.width).toBeLessThanOrEqual(854);
    expect(point.videoBps).toBeGreaterThanOrEqual(0);
  });

  it('reserves less for audio on a small budget than a large one', () => {
    // A flat 128 kbps is 13% of a 1 Mbps budget and 3% of a 4 Mbps one.
    const small = chooseOperatingPoint(900_000, 'film', 'high');
    const large = chooseOperatingPoint(4_000_000, 'film', 'high');
    expect(small.audioBps).toBeLessThan(large.audioBps);
  });
});

/**
 * The subtle half of the feedback trap.
 *
 * availableOutgoingBitrate is bounded by what we are already sending, so a
 * budget of `estimate * 0.85` recomputed every tick makes the next estimate
 * ~85% of this one, and the next ~85% of that. No single step is wrong and the
 * stream walks to the floor anyway.
 */
describe('nextBudget', () => {
  const H = 0.85;

  it('does not decay when the link is meeting the ask', () => {
    // We spend 2.55 Mbps of a 3 Mbps estimate; the estimator then reports 2.6
    // because that is roughly what we are sending. The budget must not follow.
    let budget = nextBudget(null, 3_000_000, false, H);
    expect(budget).toBe(2_550_000);

    for (let i = 0; i < 20; i++) {
      budget = nextBudget(budget, 2_600_000, false, H);
    }
    expect(budget).toBe(2_550_000);
  });

  it('follows the estimate down when the encoder is genuinely under-served', () => {
    // Asking for its ceiling and not getting it — that is the link shrinking,
    // not our own restraint reflected back.
    const budget = nextBudget(2_550_000, 1_200_000, true, H);
    expect(budget).toBe(1_020_000);
  });

  it('climbs when the link proves it has more', () => {
    expect(nextBudget(1_000_000, 4_000_000, false, H)).toBe(3_400_000);
  });

  it('holds steady when the browser publishes no estimate', () => {
    // Firefox. No opinion is never a reason to move anything.
    expect(nextBudget(2_000_000, null, false, H)).toBe(2_000_000);
    expect(nextBudget(2_000_000, null, true, H)).toBe(2_000_000);
  });

  it('never ratchets below the true capacity across a noisy run', () => {
    // A link that is genuinely 3 Mbps, with an estimator that wobbles and
    // occasional healthy ticks. The floor must hold.
    let budget = nextBudget(null, 3_000_000, false, H);
    for (const sample of [2_900_000, 2_600_000, 3_100_000, 2_700_000, 2_950_000]) {
      budget = nextBudget(budget, sample, false, H);
    }
    expect(budget).toBeGreaterThanOrEqual(2_550_000);
  });
});
