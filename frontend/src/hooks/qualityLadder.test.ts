import { describe, expect, it } from 'vitest';
import {
  GOOD_POLLS_TO_PROBE,
  INITIAL_PROBE_BACKOFF_MS,
  MAX_PROBE_BACKOFF_MS,
  VIEWER_REPORT_TTL_MS,
  currentViewerLevel,
  currentViewerViewport,
  initialLadderState,
  nextLadderState,
  stepDown,
  stepUp,
  viewerIsUnhappy,
  withUserChoice,
  type LadderSignals,
  type LadderState,
  type ViewerReport,
} from './qualityLadder';
import { initialBudgetState, minBudgetBps, nextBudget } from './operatingPoint';

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

/**
 * The receiver's leg of the control loop.
 *
 * Everything else in this pipeline reads a signal the sender can re-measure on
 * demand: the encoder's health, the candidate pair's estimate, the CPU. The
 * viewer's verdict is the one input that arrives from somewhere else and cannot
 * be re-asked for — which is what made it the last place a one-way ratchet
 * could hide. It used to be recorded as a bare level with no timestamp and no
 * reset, so one 'poor' from a peer whose cell dipped stayed true forever, and
 * `shortage` in nextBudget stayed true with it.
 */
describe('currentViewerLevel', () => {
  it('has no opinion when the viewer has never reported', () => {
    expect(currentViewerLevel(null, 500_000)).toBeNull();
  });

  it('reports a fresh verdict', () => {
    const report: ViewerReport = { level: 'poor', viewport: null, at: 1_000 };
    expect(currentViewerLevel(report, 1_000 + VIEWER_REPORT_TTL_MS)).toBe('poor');
  });

  it('expires a verdict nobody is repeating', () => {
    // The viewer re-sends every FEEDBACK_HEARTBEAT_MS, so silence past three
    // heartbeats means the reporter is gone rather than still unhappy.
    const report: ViewerReport = { level: 'critical', viewport: null, at: 1_000 };
    expect(currentViewerLevel(report, 1_001 + VIEWER_REPORT_TTL_MS)).toBeNull();
  });

  it('expires a good verdict too, not just a bad one', () => {
    // Symmetry matters: a stale 'excellent' would let the budget keep probing
    // upward against a peer that stopped watching ten minutes ago.
    const report: ViewerReport = { level: 'excellent', viewport: null, at: 0 };
    expect(currentViewerLevel(report, VIEWER_REPORT_TTL_MS * 2)).toBeNull();
  });
});

describe('a viewer verdict driving the budget', () => {
  const FLOOR = minBudgetBps(24);
  const POLL_MS = 3_000;

  /** Run the budget loop for `untilMs`, refreshing the report per `resend`. */
  function run(resend: (now: number) => boolean) {
    let budget = initialBudgetState(2_000_000, 0);
    let report: ViewerReport = { level: 'poor', viewport: null, at: 0 };

    for (let now = POLL_MS; now <= 300_000; now += POLL_MS) {
      if (resend(now)) report = { level: 'poor', viewport: null, at: now };
      budget = nextBudget(budget, {
        now,
        estimateBps: null,
        // The state the reported collapse actually sat in, so the only thing
        // deciding the outcome here is the viewer's verdict.
        health: 'self-limited',
        viewerUnhappy: viewerIsUnhappy(currentViewerLevel(report, now)),
        headroom: 0.85,
        mode: 'film',
        ceiling: 'auto',
        viewport: null,
        capacityPixelsPerSecond: null,
      });
    }
    return budget;
  }

  it('holds the budget down for as long as the viewer keeps saying so', () => {
    // Every heartbeat, forever. This is the case the signal exists for, and it
    // must survive the expiry added for the case below.
    const budget = run((now) => now % 9_000 === 0);
    expect(budget.bps).toBe(FLOOR);
  });

  it('recovers once the reports stop, instead of pinning the rest of the film', () => {
    // One report, then silence — a peer who closed the tab, walked out of
    // coverage, or simply never changed level again back when feedback was
    // sent on change only. Before the expiry this returned the floor.
    const budget = run(() => false);
    expect(budget.bps).toBeGreaterThanOrEqual(2_000_000);
  });
});

describe('a viewer verdict against a healthy estimate', () => {
  it('still lowers the budget when the estimate says there is room', () => {
    // The far end is freezing on a decoder it cannot feed, so nothing is being
    // lost in flight and the capacity estimate is honestly high. `min(bps,
    // target)` is a no-op here, and without the multiplicative path the
    // complaint would be completely inert.
    const before = initialBudgetState(2_000_000, 0);
    const after = nextBudget(before, {
      now: 3_000,
      estimateBps: 8_000_000,
      health: 'satisfied',
      viewerUnhappy: true,
      headroom: 0.85,
      mode: 'film',
      ceiling: 'auto',
      viewport: null,
      capacityPixelsPerSecond: null,
    });
    expect(after.bps).toBeLessThan(before.bps);
  });

  it('still prefers the estimate when the estimate is the tighter of the two', () => {
    // Unchanged behaviour: a trusted number below what we spend is followed
    // down to exactly itself, not discounted a second time.
    const after = nextBudget(initialBudgetState(2_000_000, 0), {
      now: 3_000,
      estimateBps: 1_000_000,
      health: 'under-served',
      viewerUnhappy: true,
      headroom: 0.85,
      mode: 'film',
      ceiling: 'auto',
      viewport: null,
      capacityPixelsPerSecond: null,
    });
    expect(after.bps).toBe(850_000);
  });
});

describe('currentViewerViewport', () => {
  it('reports a fresh viewport', () => {
    const report: ViewerReport = {
      level: 'good',
      viewport: { width: 3840, height: 2160 },
      at: 1_000,
    };
    expect(currentViewerViewport(report, 2_000)).toEqual({ width: 3840, height: 2160 });
  });

  it('expires it on the same clock as the verdict', () => {
    // A screen that stopped answering must stop authorising a 4K picture. The
    // viewport rides on the verdict's message precisely so it cannot outlive it.
    const report: ViewerReport = {
      level: 'good',
      viewport: { width: 3840, height: 2160 },
      at: 0,
    };
    expect(currentViewerViewport(report, VIEWER_REPORT_TTL_MS + 1)).toBeNull();
  });

  it('has no opinion when a peer reports quality but no size', () => {
    // An older build sends QualityFeedback without the viewport field.
    const report: ViewerReport = { level: 'good', viewport: null, at: 0 };
    expect(currentViewerViewport(report, 1_000)).toBeNull();
  });
});
