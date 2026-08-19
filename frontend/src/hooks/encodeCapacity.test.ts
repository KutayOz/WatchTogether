import { describe, expect, it } from 'vitest';
import {
  CAPACITY_BACKOFF,
  CAPACITY_CUT_INTERVAL_MS,
  CAPACITY_RETRY_MS,
  encodeCostPerFrame,
  initialCapacityState,
  nextCapacity,
  overEncodeCliff,
  type CapacitySignals,
  type CapacityState,
} from './encodeCapacity';
import { chooseOperatingPoint } from './operatingPoint';
import type { OutboundScreenStats } from '../types';

/**
 * The state this module exists for.
 *
 * A screen share froze and jumped on the receiver from its first second and
 * never recovered, while the sender's own preview — the raw capture, not the
 * encode — stayed perfectly smooth. `qualityLimitationReason` was 'cpu', and
 * 'cpu' is the one verdict every controller in this app answers by holding:
 * the budget returns unchanged, the ladder returns unchanged, and the viewer's
 * report reaches neither. Nothing could come down. This is the thing that can.
 */

function stats(over: Partial<OutboundScreenStats> = {}): OutboundScreenStats {
  return {
    frameWidth: 1920,
    frameHeight: 1080,
    framesPerSecond: 24,
    targetBitrate: 2_400_000,
    qualityLimitationReason: 'none',
    encoderImplementation: 'libvpx-vp9',
    totalEncodeTime: 0,
    framesEncoded: 0,
    ...over,
  };
}

/** 1080p24 — the point the reported failure was sitting at. */
const ASKED = 1920 * 1080 * 24;

function sig(over: Partial<CapacitySignals> = {}): CapacitySignals {
  return {
    now: 0,
    health: 'satisfied',
    previous: null,
    latest: null,
    askedPixelsPerSecond: ASKED,
    fps: 24,
    ...over,
  };
}

describe('encodeCostPerFrame', () => {
  it('differences the counters rather than reading the running totals', () => {
    // 30 frames costing 0.9 s between the two samples is 30 ms each, whatever
    // the first ten seconds of the share happened to cost.
    const cost = encodeCostPerFrame(
      stats({ totalEncodeTime: 100, framesEncoded: 1000 }),
      stats({ totalEncodeTime: 100.9, framesEncoded: 1030 }),
    );
    expect(cost).toBeCloseTo(0.03, 6);
  });

  it('has no opinion when the counters went backwards', () => {
    // A track swap resets them. A negative delta is not a fast encoder.
    expect(
      encodeCostPerFrame(
        stats({ totalEncodeTime: 100, framesEncoded: 1000 }),
        stats({ totalEncodeTime: 0.2, framesEncoded: 5 }),
      ),
    ).toBeNull();
  });

  it('has no opinion when a browser publishes neither counter', () => {
    // Firefox and Safari land here, and a guess would drive the ceiling.
    expect(encodeCostPerFrame(stats(), stats({ totalEncodeTime: null }))).toBeNull();
    expect(encodeCostPerFrame(null, stats())).toBeNull();
  });

  it('has no opinion across an interval that encoded nothing', () => {
    expect(
      encodeCostPerFrame(
        stats({ totalEncodeTime: 10, framesEncoded: 240 }),
        stats({ totalEncodeTime: 10, framesEncoded: 240 }),
      ),
    ).toBeNull();
  });
});

describe('overEncodeCliff', () => {
  it('believes Chrome when it says cpu', () => {
    expect(overEncodeCliff(sig({ health: 'cpu-bound' }))).toBe(true);
  });

  it('sees the cliff from encode time before the verdict arrives', () => {
    // 24 fps is a 41.7 ms frame interval; 35 ms of encode is 0.84 of it, past
    // ENCODE_BUDGET_FRACTION. classifySenderHealth needs three agreeing polls
    // to say 'cpu-bound' at all — this answers on the first pair.
    const over = overEncodeCliff(
      sig({
        previous: stats({ totalEncodeTime: 10, framesEncoded: 240 }),
        latest: stats({ totalEncodeTime: 12.45, framesEncoded: 310 }),
      }),
    );
    expect(over).toBe(true);
  });

  it('leaves an encoder with slack alone', () => {
    // 10 ms per frame against a 41.7 ms interval.
    const over = overEncodeCliff(
      sig({
        previous: stats({ totalEncodeTime: 10, framesEncoded: 240 }),
        latest: stats({ totalEncodeTime: 10.7, framesEncoded: 310 }),
      }),
    );
    expect(over).toBe(false);
  });

  it('scales with the frame rate', () => {
    // The same 25 ms per frame is comfortable at 24 fps and hopeless at 60.
    const encode = {
      previous: stats({ totalEncodeTime: 10, framesEncoded: 240 }),
      latest: stats({ totalEncodeTime: 11.75, framesEncoded: 310 }),
    };
    expect(overEncodeCliff(sig({ ...encode, fps: 24 }))).toBe(false);
    expect(overEncodeCliff(sig({ ...encode, fps: 60 }))).toBe(true);
  });
});

describe('nextCapacity', () => {
  it('says nothing at all while the encoder is keeping up', () => {
    // null is "no opinion", the same as everywhere else in this pipeline. An
    // untroubled share must not carry a ceiling it never needed.
    const state = nextCapacity(initialCapacityState(), sig({ now: 5_000 }));
    expect(state.maxPixelsPerSecond).toBeNull();
  });

  it('comes down when the encoder is CPU-limited', () => {
    const state = nextCapacity(initialCapacityState(), sig({ now: 9_000, health: 'cpu-bound' }));
    expect(state.maxPixelsPerSecond).toBe(ASKED * CAPACITY_BACKOFF);
  });

  it('lowers the picture, which is what a CPU limit is actually about', () => {
    // The point of the whole module: the bitrate is untouched, so bits per
    // pixel RISES as the picture shrinks. `SenderHealth`'s contract that a CPU
    // limit "MUST NOT be answered by lowering the bitrate" is kept exactly.
    const before = chooseOperatingPoint(2_571_000, 'film');
    const state = nextCapacity(initialCapacityState(), sig({ now: 9_000, health: 'cpu-bound' }));
    const after = chooseOperatingPoint(2_571_000, 'film', 'auto', null, state.maxPixelsPerSecond);

    expect(after.width).toBeLessThan(before.width);
    expect(after.videoBps).toBe(before.videoBps);
    expect(after.bpp).toBeGreaterThan(before.bpp);
  });

  it('does not cut again before the last cut could be judged', () => {
    // 'cpu-bound' keeps holding once it holds, and the effect fires every poll.
    // Without the gate one spike would compound to 0.42 in nine seconds.
    let state: CapacityState = initialCapacityState();
    for (const now of [0, 3_000, 6_000]) {
      state = nextCapacity(state, sig({ now, health: 'cpu-bound' }));
    }
    expect(state.maxPixelsPerSecond).toBe(ASKED * CAPACITY_BACKOFF);
  });

  it('keeps cutting when a whole window of pressure has passed', () => {
    let state = nextCapacity(initialCapacityState(), sig({ now: 0, health: 'cpu-bound' }));
    const first = state.maxPixelsPerSecond!;
    state = nextCapacity(
      state,
      sig({ now: CAPACITY_CUT_INTERVAL_MS + 1, health: 'cpu-bound', askedPixelsPerSecond: first }),
    );
    expect(state.maxPixelsPerSecond).toBeLessThan(first);
  });

  it('never cuts below the floor this codebase already defends', () => {
    // 640x360 at TARGET_BPP is the smallest thing operatingPoint will send. A
    // ceiling under it would leave the chooser nothing to pick — and
    // unwatchable is worse than wasteful, which that file already settled.
    let state: CapacityState = initialCapacityState();
    for (let i = 0; i < 40; i++) {
      state = nextCapacity(
        state,
        sig({
          now: i * (CAPACITY_CUT_INTERVAL_MS + 1),
          health: 'cpu-bound',
          askedPixelsPerSecond: state.maxPixelsPerSecond ?? ASKED,
        }),
      );
    }
    expect(state.maxPixelsPerSecond).toBe(640 * 360 * 24);
  });

  it('lets a transient spike go rather than pinning the session', () => {
    // A minute of compiling in the background must not cost the rest of the
    // film. Same argument as MAX_BUDGET_PROBE_BACKOFF_MS.
    const cut = nextCapacity(initialCapacityState(), sig({ now: 0, health: 'cpu-bound' }));
    const later = nextCapacity(cut, sig({ now: CAPACITY_RETRY_MS + 1 }));
    expect(later.maxPixelsPerSecond).toBeGreaterThan(cut.maxPixelsPerSecond!);
  });

  it('gives up the ceiling entirely once it exceeds anything we would send', () => {
    // Past 4K the bound stops being a bound; returning to null keeps "no
    // opinion" meaning exactly that.
    let state: CapacityState = { maxPixelsPerSecond: 3840 * 2160 * 24 * 0.9, lastChangeAt: 0 };
    state = nextCapacity(state, sig({ now: CAPACITY_RETRY_MS + 1 }));
    expect(state.maxPixelsPerSecond).toBeNull();
  });

  it('holds its ground while the ceiling is still young', () => {
    const cut = nextCapacity(initialCapacityState(), sig({ now: 0, health: 'cpu-bound' }));
    const soon = nextCapacity(cut, sig({ now: 30_000 }));
    expect(soon).toBe(cut);
  });
});
