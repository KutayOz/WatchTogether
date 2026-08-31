import {
  QUALITY_LADDER,
  type QualityLevel,
  type ScreenShareQuality,
  type Viewport,
} from '../types';
import type { SenderHealth } from './useSenderHealth';

/**
 * When quality moves on its own, and how far.
 *
 * Pure, and exported as a function of plain values, because SessionRoom.tsx is
 * 1800 lines with no component tests — the convention in this codebase is that
 * anything carrying judgement lives in a function a unit test can reach
 * (estimateFromBitrate, calculateQualityScore, scoreToLevel).
 *
 * The old behaviour this replaces had three separate faults:
 *
 *  1. It only ever went DOWN. Nothing raised quality, ever, so one bad
 *     three-second window pinned a user for the rest of the session.
 *  2. It PERSISTED those automatic drops to localStorage, so the pin outlived
 *     the session and every future call started at the floor.
 *  3. It ran on camera-only calls, where a ~1 Mbps estimate reflects a webcam
 *     and nothing else, and rewrote the setting before a share ever started.
 *
 * The shape here inverts that: an explicit human choice is a sticky CEILING,
 * automatic movement happens underneath it in both directions, and nothing
 * automatic is ever written to storage.
 */

/** Cooldown before the first upward probe after any automatic change. */
export const INITIAL_PROBE_BACKOFF_MS = 30_000;

/** Backoff never grows past this — ten minutes between probes at worst. */
export const MAX_PROBE_BACKOFF_MS = 600_000;

/** Consecutive 'satisfied' verdicts required before probing upward. */
export const GOOD_POLLS_TO_PROBE = 4;

/** How long after a probe a bad report is read as "the probe failed". */
export const PROBE_VERDICT_WINDOW_MS = 15_000;

export interface LadderState {
  /** The user's explicit pick. Automatic movement never exceeds this. */
  ceiling: ScreenShareQuality;
  /** What is applied right now. */
  applied: ScreenShareQuality;
  lastAutoChangeAt: number;
  probeBackoffMs: number;
  /** Consecutive healthy observations. */
  consecutiveGood: number;
  /** Set when the last automatic change was an upward probe, so we can undo it. */
  probing: boolean;
}

export interface LadderSignals {
  now: number;
  isSharing: boolean;
  senderHealth: SenderHealth;
  /** The viewer's own report, or null when they have not sent one. */
  viewerLevel: QualityLevel | null;
}

export function initialLadderState(ceiling: ScreenShareQuality, now = 0): LadderState {
  return {
    ceiling,
    applied: ceiling,
    lastAutoChangeAt: now,
    probeBackoffMs: INITIAL_PROBE_BACKOFF_MS,
    consecutiveGood: 0,
    probing: false,
  };
}

/** One rung cheaper, or null at the floor. */
export function stepDown(q: ScreenShareQuality): ScreenShareQuality | null {
  const i = QUALITY_LADDER.indexOf(q);
  if (i <= 0) return null;
  return QUALITY_LADDER[i - 1];
}

/** One rung dearer, never past the ceiling. Null when there is no room. */
export function stepUp(
  q: ScreenShareQuality,
  ceiling: ScreenShareQuality,
): ScreenShareQuality | null {
  const i = QUALITY_LADDER.indexOf(q);
  const capIndex = QUALITY_LADDER.indexOf(ceiling);
  // 'auto' is not on the ladder (indexOf -1). It sets no fixed rung of its own,
  // so there is nothing to step to or from.
  if (i < 0 || capIndex < 0) return null;
  if (i + 1 > capIndex) return null;
  return QUALITY_LADDER[i + 1];
}

/**
 * How long a viewer report stays actionable.
 *
 * The viewer re-sends its verdict on a heartbeat as well as on change (see
 * FEEDBACK_HEARTBEAT_MS in useQualityMonitor), so silence well past a few
 * heartbeats means the reporter is gone — not that everything is fine. Three
 * heartbeats plus slack, so two consecutive lost messages cannot flap it.
 *
 * Without an expiry the receiver's leg of this control loop is a one-way
 * ratchet, which is the exact failure the sender's leg was just rebuilt to
 * remove: a single 'poor' latched forever makes `shortage` permanently true in
 * nextBudget, which walks the budget to its floor and then short-circuits the
 * probe branch that is the only way back up. A peer whose link dipped once, or
 * who closed their laptop, would pin the rest of the film at 640x360.
 */
export const VIEWER_REPORT_TTL_MS = 30_000;

/** What the far end last told us about itself, with the time it said it. */
export interface ViewerReport {
  level: QualityLevel;
  /** How big the picture is being drawn over there, or null if not reported. */
  viewport: Viewport | null;
  /**
   * How big the arriving picture actually is over there, or null if not
   * reported. Against `viewport`, this is the deficit — see viewerIsStarved.
   */
  picture: Viewport | null;
  /** Arrival time, on the same clock the reducers are given through `now`. */
  at: number;
}

/**
 * How small the arriving picture has to get, against the space it is drawn
 * into, before the sender treats it as evidence rather than as normal downscale.
 *
 * An area ratio, so a ninth means "at most a third the size in each dimension".
 * The line has to sit below every downscale a healthy constrained link produces
 * and above the collapse this exists to catch, and those are not close together:
 * 960x540 painted at 1920x1080 is a quarter, 1280x720 at 2386x1358 is 0.28, and
 * the captured collapse — 300x158 at 2386x1358 — is 0.015. Nearly an order of
 * magnitude of daylight on either side.
 */
export const VIEWER_STARVED_AREA_RATIO = 1 / 9;

/**
 * Is the far end being sent far less picture than it has room for, while
 * reporting that the connection is fine?
 *
 * Both halves matter. The deficit alone is not actionable — a viewer that is
 * ALSO complaining is describing a link in trouble, and `viewerUnhappy` already
 * carries that to the budget as a reason to send less. This is the opposite
 * case, and the one nothing could see: a clean, smooth, tiny picture. The
 * receiver's own score cannot represent it, because every term in
 * `calculateQualityScore` is about delivery rather than about size.
 *
 * Null-safe throughout, and false whenever a term is missing: a peer on an
 * older build reports no picture size, and absence must not manufacture a
 * verdict. Same discipline as estimateFromBitrate's capacityKnown.
 */
export function viewerIsStarved(report: ViewerReport | null, now: number): boolean {
  const fresh = freshViewerReport(report, now);
  if (!fresh || !fresh.viewport || !fresh.picture) return false;
  // A complaint is a different signal with a different answer. Do not let one
  // report drive the budget in both directions at once.
  if (viewerIsUnhappy(fresh.level)) return false;

  const room = fresh.viewport.width * fresh.viewport.height;
  const arriving = fresh.picture.width * fresh.picture.height;
  if (room <= 0 || arriving <= 0) return false;
  return arriving < room * VIEWER_STARVED_AREA_RATIO;
}

/**
 * The report, or null once it is too old to act on.
 *
 * Null is the same "no opinion" the rest of this pipeline uses (see
 * estimateFromBitrate's capacityKnown, nextBudget's estimateBps) rather than a
 * cheerful default: an expired report must neither hold quality down nor claim
 * the link is healthy — and an expired VIEWPORT must not keep us sending 4K to
 * a screen that stopped answering.
 */
export function freshViewerReport(
  report: ViewerReport | null,
  now: number,
): ViewerReport | null {
  if (!report) return null;
  return now - report.at > VIEWER_REPORT_TTL_MS ? null : report;
}

/** The viewer's verdict, or null when there is no fresh one. */
export function currentViewerLevel(
  report: ViewerReport | null,
  now: number,
): QualityLevel | null {
  return freshViewerReport(report, now)?.level ?? null;
}

/** The viewer's viewport, or null when there is no fresh one. */
export function currentViewerViewport(
  report: ViewerReport | null,
  now: number,
): Viewport | null {
  return freshViewerReport(report, now)?.viewport ?? null;
}

/** The size actually arriving over there, or null when there is no fresh one. */
export function currentViewerPicture(report: ViewerReport | null, now: number): Viewport | null {
  return freshViewerReport(report, now)?.picture ?? null;
}

/** A viewer report that means "this is working". */
function viewerIsHappy(level: QualityLevel | null): boolean {
  // null = the viewer has not reported. Absence of complaint is not evidence of
  // health, but it must not block recovery either, so treat it as neutral.
  return level === null || level === 'excellent' || level === 'good';
}

/**
 * A viewer report that means "this is not working".
 *
 * Exported because nextBudget needs the same test through its `viewerUnhappy`
 * flag. It was a duplicated `=== 'poor' || === 'critical'` literal in
 * SessionRoom, which is how the two consumers of one signal drift apart.
 */
export function viewerIsUnhappy(level: QualityLevel | null): boolean {
  return level === 'poor' || level === 'critical';
}

/**
 * Advance the ladder by one observation.
 *
 * Returns a new state; `current` changing is the caller's cue to apply it.
 * Never mutates, never touches storage, never reads the clock — `now` comes in
 * through signals so the whole thing is testable without fake timers.
 */
export function nextLadderState(state: LadderState, sig: LadderSignals): LadderState {
  // Nothing moves when there is no share on the wire. This is the gate whose
  // absence let a camera-only call rewrite the user's saved quality.
  if (!sig.isSharing) return state;

  // CPU pressure is not a bandwidth problem and must not be answered like one.
  // Lowering the bitrate does not buy the encoder any CPU; it just spends fewer
  // bits on an already-struggling picture. A whole preset step is the wrong
  // granularity for it in any case. So hold — and the caller does now respond,
  // through `encodeCapacity` (fewer pixels, same bitrate) and
  // `shouldDowngradeCodec` (a codec the machine can actually run). For a long
  // time neither existed and this comment was the whole treatment.
  if (sig.senderHealth === 'cpu-bound') {
    return { ...state, consecutiveGood: 0 };
  }

  // Nor is a still screen. The frames are not being made — see 'source-idle' in
  // useSenderHealth — so nothing the ladder can reach is the cause and nothing
  // it can do is the cure.
  //
  // Holding matters more here than in the budget, because a ladder step is
  // PERSISTENT: `sig.viewerLevel === 'critical'` reaches the step-down below,
  // and a viewer watching a motionless capture reports critical indefinitely.
  // That is a preset walked down and written to the user's saved quality for
  // the sole reason that nobody moved the window they were sharing.
  if (sig.senderHealth === 'source-idle') {
    return { ...state, consecutiveGood: 0 };
  }

  const sinceChange = sig.now - state.lastAutoChangeAt;

  // Did an upward probe just fail? Judged inside a short window after the
  // change, so a dip ten minutes later is not blamed on the probe.
  if (state.probing && sinceChange <= PROBE_VERDICT_WINDOW_MS) {
    if (sig.senderHealth === 'under-served' || viewerIsUnhappy(sig.viewerLevel)) {
      const back = stepDown(state.applied);
      return {
        ...state,
        applied: back ?? state.applied,
        lastAutoChangeAt: sig.now,
        // Double the wait. A link that genuinely cannot hold the next rung
        // stops being poked every thirty seconds.
        probeBackoffMs: Math.min(state.probeBackoffMs * 2, MAX_PROBE_BACKOFF_MS),
        consecutiveGood: 0,
        probing: false,
      };
    }
  }

  // Sustained trouble → step down. No cooldown gate: getting out of a bad state
  // should not have to wait on a timer meant for probing.
  if (sig.senderHealth === 'under-served' || sig.viewerLevel === 'critical') {
    const down = stepDown(state.applied);
    if (!down) return { ...state, consecutiveGood: 0, probing: false };
    return {
      ...state,
      applied: down,
      lastAutoChangeAt: sig.now,
      consecutiveGood: 0,
      probing: false,
    };
  }

  // Healthy. Accumulate evidence, then probe upward.
  // 'self-limited' counts as healthy: the encoder is getting everything it was
  // given and wants more. Leaving it out would make a new union member silently
  // mean "not healthy", which is the failure this member exists to end.
  const healthy =
    (sig.senderHealth === 'satisfied' || sig.senderHealth === 'self-limited') &&
    viewerIsHappy(sig.viewerLevel);
  if (!healthy) return { ...state, consecutiveGood: 0 };

  const consecutiveGood = state.consecutiveGood + 1;
  const eligible =
    consecutiveGood >= GOOD_POLLS_TO_PROBE && sinceChange > state.probeBackoffMs;
  if (!eligible) return { ...state, consecutiveGood };

  const up = stepUp(state.applied, state.ceiling);
  if (!up) return { ...state, consecutiveGood };

  return {
    ...state,
    applied: up,
    lastAutoChangeAt: sig.now,
    consecutiveGood: 0,
    probing: true,
  };
}

/**
 * The user picked a quality. That is a ceiling AND an immediate move, and it
 * resets the backoff — an explicit choice is a fresh statement of intent, not
 * something to be second-guessed by the history of automatic probes.
 */
export function withUserChoice(choice: ScreenShareQuality, now: number): LadderState {
  return {
    ceiling: choice,
    applied: choice,
    lastAutoChangeAt: now,
    probeBackoffMs: INITIAL_PROBE_BACKOFF_MS,
    consecutiveGood: 0,
    probing: false,
  };
}
