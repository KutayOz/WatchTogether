import { describe, expect, it } from 'vitest';
import {
  GOOD_POLLS_TO_PROBE,
  INITIAL_PROBE_BACKOFF_MS,
  MAX_PROBE_BACKOFF_MS,
  initialLadderState,
  nextLadderState,
  stepDown,
  stepUp,
  withUserChoice,
  type LadderSignals,
  type LadderState,
} from './qualityLadder';

/**
 * How quality is allowed to move on its own.
 *
 * The behaviour this replaces had three faults that compounded: it only ever
 * went DOWN, it PERSISTED those automatic drops, and it ran on camera-only
 * calls where the estimate reflects a webcam and nothing else. Together they
 * meant one bad three-second window pinned a user at the floor for every future
 * session, on a link that may have been fine the whole time.
 */

const BASE: LadderSignals = {
  now: 0,
  isSharing: true,
  senderHealth: 'unknown',
  viewerLevel: null,
};

/** Feed the ladder a run of identical observations. */
function run(state: LadderState, sig: Partial<LadderSignals>, times: number, stepMs = 3000) {
  let s = state;
  for (let i = 0; i < times; i++) {
    s = nextLadderState(s, { ...BASE, ...sig, now: (sig.now ?? 0) + i * stepMs });
  }
  return s;
}

describe('nextLadderState', () => {
  it('does nothing at all when no share is running', () => {
    // The gate whose absence let a camera-only call — where a ~1 Mbps estimate
    // describes a webcam and nothing else — rewrite the saved quality before a
    // share had ever started.
    const start = initialLadderState('high');
    const after = run(start, { isSharing: false, senderHealth: 'under-served' }, 10);
    expect(after).toEqual(start);
  });

  it('steps down when the encoder is sustainedly under-served', () => {
    const after = nextLadderState(initialLadderState('high'), {
      ...BASE,
      senderHealth: 'under-served',
    });
    expect(after.applied).toBe('medium');
  });

  it('never steps below the floor', () => {
    const floored = run(initialLadderState('low'), { senderHealth: 'under-served' }, 5);
    expect(floored.applied).toBe('low');
  });

  it('does not act on a single healthy observation', () => {
    // Recovery must require evidence. One good window is noise.
    const after = nextLadderState(
      { ...initialLadderState('high'), applied: 'low' },
      { ...BASE, senderHealth: 'satisfied', now: INITIAL_PROBE_BACKOFF_MS + 1 },
    );
    expect(after.applied).toBe('low');
    expect(after.consecutiveGood).toBe(1);
  });

  it('probes upward after sustained health — the thing that never used to happen', () => {
    const start = { ...initialLadderState('high'), applied: 'low' as const };
    const after = run(
      start,
      { senderHealth: 'satisfied', now: INITIAL_PROBE_BACKOFF_MS + 1 },
      GOOD_POLLS_TO_PROBE,
    );
    expect(after.applied).toBe('medium');
    expect(after.probing).toBe(true);
  });

  it('raises exactly one rung per probe', () => {
    const start = { ...initialLadderState('extreme'), applied: 'low' as const };
    const after = run(
      start,
      { senderHealth: 'satisfied', now: INITIAL_PROBE_BACKOFF_MS + 1 },
      GOOD_POLLS_TO_PROBE * 3,
    );
    // Three rungs' worth of good news, but the backoff gates each subsequent
    // probe — so it climbs deliberately rather than leaping.
    expect(after.applied).toBe('medium');
  });

  it('never raises above the user\'s explicit ceiling', () => {
    const start = initialLadderState('medium'); // user picked medium
    const after = run(
      start,
      { senderHealth: 'satisfied', now: INITIAL_PROBE_BACKOFF_MS + 1 },
      GOOD_POLLS_TO_PROBE * 4,
    );
    expect(after.applied).toBe('medium');
  });

  it('backs off exponentially when a probe fails', () => {
    const probed: LadderState = {
      ...initialLadderState('high'),
      applied: 'medium',
      lastAutoChangeAt: 1000,
      probing: true,
    };
    const failed = nextLadderState(probed, {
      ...BASE,
      now: 4000, // inside the verdict window
      senderHealth: 'under-served',
    });

    expect(failed.applied).toBe('low');
    expect(failed.probeBackoffMs).toBe(INITIAL_PROBE_BACKOFF_MS * 2);
    expect(failed.probing).toBe(false);
  });

  it('caps the backoff so a link is not poked forever', () => {
    let state: LadderState = {
      ...initialLadderState('extreme'),
      probeBackoffMs: MAX_PROBE_BACKOFF_MS,
      applied: 'medium',
      lastAutoChangeAt: 0,
      probing: true,
    };
    state = nextLadderState(state, { ...BASE, now: 1000, senderHealth: 'under-served' });
    expect(state.probeBackoffMs).toBe(MAX_PROBE_BACKOFF_MS);
  });

  it('never answers CPU pressure with a bitrate change', () => {
    // Fewer bits do not buy the encoder any CPU — they just make an already
    // struggling picture worse. The right answers are a smaller resolution or a
    // cheaper codec, neither of which is this function's job.
    const start = initialLadderState('high');
    const after = run(start, { senderHealth: 'cpu-bound' }, 10);
    expect(after.applied).toBe('high');
  });

  it('steps down on a critical viewer report', () => {
    const after = nextLadderState(initialLadderState('high'), {
      ...BASE,
      viewerLevel: 'critical',
    });
    expect(after.applied).toBe('medium');
  });

  it('does not climb while the viewer is unhappy', () => {
    // Our own encoder can be perfectly satisfied while the far end is drowning.
    const start = { ...initialLadderState('high'), applied: 'low' as const };
    const after = run(
      start,
      { senderHealth: 'satisfied', viewerLevel: 'poor', now: INITIAL_PROBE_BACKOFF_MS + 1 },
      GOOD_POLLS_TO_PROBE * 2,
    );
    expect(after.applied).toBe('low');
  });
});

describe('withUserChoice', () => {
  it('makes an explicit pick both the ceiling and the current value', () => {
    const after = withUserChoice('high', 5000);
    expect(after.ceiling).toBe('high');
    expect(after.applied).toBe('high');
  });

  it('resets the backoff, because a human choice is a fresh statement of intent', () => {
    const after = withUserChoice('medium', 5000);
    expect(after.probeBackoffMs).toBe(INITIAL_PROBE_BACKOFF_MS);
    expect(after.probing).toBe(false);
  });
});

describe('stepUp / stepDown', () => {
  it('returns null at the ends rather than clamping silently', () => {
    expect(stepDown('low')).toBeNull();
    expect(stepUp('extreme', 'extreme')).toBeNull();
  });

  it('treats auto as off-ladder', () => {
    // 'auto' sets no fixed rung of its own — it is the budget deciding — so
    // there is nothing to step to or from.
    expect(stepUp('auto', 'high')).toBeNull();
    expect(stepDown('auto')).toBeNull();
  });
});

describe('nextLadderState and a self-limited encoder', () => {
  it('treats a self-limited encoder as room to grow', () => {
    // A new SenderHealth member must not silently mean "not healthy" — that is
    // the failure mode 'self-limited' was added to end.
    let state: LadderState = {
      ceiling: 'extreme',
      applied: 'low',
      lastAutoChangeAt: 0,
      probeBackoffMs: 30_000,
      consecutiveGood: 0,
      probing: false,
    };

    for (let i = 1; i <= 4; i++) {
      state = nextLadderState(state, {
        now: 60_000 + i,
        isSharing: true,
        senderHealth: 'self-limited',
        viewerLevel: 'good',
      });
    }

    expect(state.applied).toBe('medium');
    expect(state.probing).toBe(true);
  });
});
