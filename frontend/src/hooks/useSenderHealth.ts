import { useCallback, useEffect, useRef, useState } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { OutboundScreenStats } from '../types';

/**
 * Is the encoder getting what it asked for?
 *
 * This replaces `availableOutgoingBitrate` as the CONTROL input for quality,
 * and the reason is a feedback trap in the old design. Chrome's estimate is
 * bounded by what you are already sending: clamp the encoder down and the next
 * estimate falls with it, which justifies clamping again. The estimator ends up
 * measuring the cage it is locked in, and a link ratchets to the floor without
 * ever having been that slow.
 *
 * Asking the encoder instead inverts the confound. We tell it a ceiling; it
 * reports what it could actually achieve. That answer is about the link, not
 * about our own restraint — and it is naturally hysteretic, because once we
 * clamp to a point the encoder can sustain, `targetBitrate` sits AT the ceiling
 * and "under-served" simply stops being true. The spiral cannot form.
 *
 * It is also the only signal here that can say *raise*.
 */

const POLL_INTERVAL_MS = 3000;

/** Consecutive polls before a verdict is trusted. Three polls ~= 9 seconds. */
const SUSTAIN_POLLS = 3;

/** Below this fraction of the ceiling, the encoder is not getting its ask. */
const UNDER_SERVED_RATIO = 0.85;

/** At or above this fraction, it is comfortably served and there may be room. */
const SATISFIED_RATIO = 0.95;

export type SenderHealth =
  /** Bandwidth-limited and materially below the configured ceiling. */
  | 'under-served'
  /** Hitting its ceiling with no limitation — there may be headroom above. */
  | 'satisfied'
  /**
   * Got everything we asked for, and the picture is STILL being degraded.
   *
   * `targetBitrate` is `min(our maxBitrate, the estimator's allocation)`, so
   * `targetBitrate` sitting at our ceiling proves the estimator is offering at
   * least that much. Reason 'bandwidth' alongside it therefore does not mean
   * the link is short — it means OUR CEILING is what the encoder is bumping
   * against. That is a reason to raise, and the classifier used to throw it
   * away: the reported collapse sat here (targetBitrate 30k against a 25k
   * ceiling, ratio 1.2) and got 'unknown', which froze the budget and reset the
   * ladder's good-poll count on every single poll. A deadlock, not a slide.
   */
  | 'self-limited'
  /**
   * Encoder cannot keep up. MUST NOT be answered by lowering the bitrate:
   * fewer bits do not buy CPU, they just make the picture worse for nothing.
   * The right answers are a smaller resolution or a cheaper codec.
   *
   * Both of those exist now, and neither is a bitrate. `encodeCapacity` bounds
   * the PIXEL rate — which leaves the bitrate alone, so bits per pixel actually
   * rises as the picture shrinks — and `shouldDowngradeCodec` below moves a
   * software VP9 encode to H.264. This verdict used to reach a `return state`
   * in every controller and nothing else at all, which is how a share that
   * froze and jumped on the receiver could do it from the first second and
   * never recover: the viewer's own report is read AFTER this branch, so a
   * CPU-bound sender could not even hear the complaint.
   */
  | 'cpu-bound'
  /**
   * The frames are not being MADE. Nothing downstream can answer this.
   *
   * `getDisplayMedia` is change-driven: a still window — a paused video, a
   * document nobody is scrolling — produces about one frame a second, and the
   * encoder faithfully sends about one frame a second. Every downstream reading
   * then looks like a link in trouble. It is not. There is nothing to send.
   *
   * This verdict exists because the reported freeze-then-jump turned out to be
   * that misreading, not the CPU cliff `cpu-bound` was built for. A captured
   * session shows it exactly: `asked 640x360@30 / sending 1280x678@1 / limit
   * none` on a 4.7 Mbps p2p/udp path with 32 ms of RTT. The viewer scored the
   * arriving 1 fps as 'critical' (see calculateQualityScore — frame rate was a
   * term in a MINIMUM, so it alone decided the verdict), the sender read
   * `viewerUnhappy` as shortage, and nextBudget's multiplicative back-off
   * walked 1.9 Mbps down to 250 kbps in thirteen polls — the ratio between
   * consecutive `updateScreenShareQuality` logs is BACKOFF_FACTOR to three
   * decimals. Then the video resumed against a budget sized for nothing, and
   * THAT is what froze and jumped.
   *
   * The only correct response is to stop moving. Not to lower the budget, which
   * is what was happening; not to raise it either, since a still screen is no
   * evidence of headroom.
   */
  | 'source-idle'
  /** Not sharing, or the browser does not publish enough to judge. */
  | 'unknown';

/**
 * How far under the asked frame rate counts as "the frames are not arriving".
 *
 * A fifth, which is much lower than it first needs to be, and the reason is
 * that this verdict FREEZES the budget. Being wrong in the loose direction is
 * therefore not a small error: content that is genuinely slower than the ask —
 * a 30 fps game shared in `games` mode, which asks for 60 — would sit here for
 * the whole session with nothing able to adapt. Half would have caught exactly
 * that, and a healthy encoder delivering 28 of 60 with it.
 *
 * Starvation does not need the margin anyway. It is not a near miss: the
 * captured session's still stretches read 1 fps against an ask of 30, and its
 * healthy tail read 23-27. A fifth puts the line at 6 fps of 30, or 12 of 60,
 * with nothing observed anywhere near it.
 */
export const SOURCE_IDLE_FPS_RATIO = 0.2;

/**
 * How much of the asked picture must still be arriving for a low frame rate to
 * be the SOURCE's doing rather than the encoder's.
 *
 * This is the half of the test that makes it safe. `applyVideoEncoding` asks
 * for 'maintain-framerate', which means a genuinely bandwidth-starved encoder
 * spends its resolution first and only starves frames once it has nothing left
 * to shrink — so a small picture at a low frame rate is a real shortage and
 * must keep reaching the branches below. A picture at or above full size at one
 * frame a second cannot be produced by any amount of bandwidth pressure. In the
 * captured session the encoder was sending 1280x678 while being asked for
 * 640x360: nearly four times the pixels, a thirtieth of the frames.
 *
 * Not 1.0 because the capturer's own aspect ratio letterboxes the box we ask
 * for — 640x360 asked, 640x338 captured — and that 6% is not the encoder
 * giving up.
 */
export const SOURCE_IDLE_AREA_RATIO = 0.8;

/**
 * Are the frames simply not being produced?
 *
 * Both halves are required, and the second one is what keeps this from eating
 * real shortages — see SOURCE_IDLE_AREA_RATIO. Answering false whenever a term
 * is missing is deliberate: Firefox and Safari publish no `framesPerSecond`
 * here, and a browser we cannot read must fall through to the bitrate ratio
 * rather than be declared idle on no evidence.
 *
 * Pure and exported for the same reason `classifySenderHealth` is.
 *
 * @param askedFps The operating point's frame rate — what we asked for, not
 *   what the content mode nominally is, since a preset can cap it lower.
 */
export function sourceIsIdle(
  stats: OutboundScreenStats | null,
  askedArea: number | null,
  askedFps: number | null,
): boolean {
  if (!stats) return false;
  if (!askedFps || askedFps <= 0 || !askedArea || askedArea <= 0) return false;

  const { framesPerSecond, frameWidth, frameHeight } = stats;
  if (
    typeof framesPerSecond !== 'number' ||
    typeof frameWidth !== 'number' ||
    typeof frameHeight !== 'number'
  ) {
    return false;
  }

  if (framesPerSecond >= askedFps * SOURCE_IDLE_FPS_RATIO) return false;

  // The encoder has not given up on resolution, so it has not given up at all.
  return frameWidth * frameHeight >= askedArea * SOURCE_IDLE_AREA_RATIO;
}

/**
 * Classify a single sample.
 *
 * Exported and pure because this is the part with the judgement in it — the
 * same convention as estimateFromBitrate and calculateQualityScore.
 *
 * @param configuredBps The ceiling we set, i.e. the operating point's videoBps.
 * @param askedArea     Pixels per frame the operating point asked for, so a low
 *   frame rate can be attributed to the source rather than the link.
 * @param askedFps      Frames per second the operating point asked for.
 */
export function classifySenderHealth(
  stats: OutboundScreenStats | null,
  configuredBps: number | null,
  askedArea: number | null = null,
  askedFps: number | null = null,
): SenderHealth {
  if (!stats) return 'unknown';

  // CPU first: it is the one verdict whose correct response is different in
  // kind, so it must never be masked by a bandwidth reading.
  if (stats.qualityLimitationReason === 'cpu') return 'cpu-bound';

  // Then the source, BEFORE any reading that could be blamed on the link. This
  // ordering is the fix: every branch below reads a bitrate, and a bitrate is
  // exactly what collapses when the frames stop coming — which is how a still
  // screen used to be classified 'under-served' and answered with a back-off.
  if (sourceIsIdle(stats, askedArea, askedFps)) return 'source-idle';

  // Without both terms there is no ratio to judge, and a guess here would drive
  // the ladder. Firefox and Safari land in this branch.
  if (typeof stats.targetBitrate !== 'number' || !configuredBps || configuredBps <= 0) {
    return 'unknown';
  }

  const ratio = stats.targetBitrate / configuredBps;

  if (stats.qualityLimitationReason === 'bandwidth' && ratio < UNDER_SERVED_RATIO) {
    return 'under-served';
  }
  if (stats.qualityLimitationReason === 'none' && ratio >= SATISFIED_RATIO) {
    return 'satisfied';
  }
  // Served in full, yet still limited by something other than CPU. The ceiling
  // we set is the binding constraint — see 'self-limited' above.
  if (ratio >= SATISFIED_RATIO) {
    return 'self-limited';
  }
  return 'unknown';
}

/**
 * Is this encoder running in software?
 *
 * `encoderImplementation` is a free-form browser string, which is why this is a
 * match against what browsers actually publish rather than a lookup: Chrome
 * reports 'libvpx' / 'libvpx-vp9' / 'libaom' / 'OpenH264' for its own encoders
 * and 'ExternalEncoder' (plus platform names like 'VideoToolbox' and
 * 'MediaFoundationVideoEncodeAccelerator') when the work is on silicon.
 * Simulcast wraps the name — 'SimulcastEncoderAdapter (libvpx, libvpx)' — so
 * this searches rather than compares.
 *
 * Unknown is NOT software. A codec downgrade costs the viewer a decoder
 * teardown and a keyframe, and a browser that publishes nothing here (Firefox,
 * Safari) should get the pixel bound instead, which costs nothing.
 */
export function isSoftwareEncoder(implementation: string | null): boolean {
  if (!implementation) return false;
  return /libvpx|libaom|openh264|ffmpeg|libx264/i.test(implementation);
}

/**
 * Should this share give up on its codec?
 *
 * Only when both halves are true: the encoder is CPU-bound, and it is running
 * in software. A hardware encoder that is CPU-bound is telling us something
 * about the machine, not about the codec, and swapping codecs would spend a
 * keyframe to learn nothing.
 *
 * Pure and exported for the same reason `classifySenderHealth` is — this is
 * the part with the judgement in it, and the caller only does the plumbing.
 */
export function shouldDowngradeCodec(
  stats: OutboundScreenStats | null,
  health: SenderHealth,
): boolean {
  if (health !== 'cpu-bound') return false;
  return isSoftwareEncoder(stats?.encoderImplementation ?? null);
}

export interface SenderHealthState {
  /** The sustained verdict — only set once SUSTAIN_POLLS agree. */
  health: SenderHealth;
  /** How many consecutive polls have agreed. Lets callers require a longer run. */
  streak: number;
  /** Most recent raw sample, for display. */
  latest: OutboundScreenStats | null;
}

/**
 * @param isActive      Poll while true (i.e. while sharing).
 * @param configuredBps The ceiling currently applied, so the ratio is honest.
 * @param asked         The geometry currently applied, so a frame rate far
 *   under it can be attributed to the source. Null while not sharing.
 */
export function useSenderHealth(
  isActive: boolean,
  configuredBps: number | null,
  asked: { area: number; fps: number } | null = null,
): SenderHealthState {
  const [state, setState] = useState<SenderHealthState>({
    health: 'unknown',
    streak: 0,
    latest: null,
  });

  // Refs, not state: the poller must read the *current* ceiling and streak
  // without re-creating the interval every time either changes.
  const configuredRef = useRef(configuredBps);
  useEffect(() => {
    configuredRef.current = configuredBps;
  }, [configuredBps]);

  const askedRef = useRef(asked);
  useEffect(() => {
    askedRef.current = asked;
  }, [asked]);

  const runRef = useRef<{ verdict: SenderHealth; count: number }>({
    verdict: 'unknown',
    count: 0,
  });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const stats = await webrtcService.getOutboundScreenStats().catch(() => null);
    const askedNow = askedRef.current;
    const verdict = classifySenderHealth(
      stats,
      configuredRef.current,
      askedNow?.area ?? null,
      askedNow?.fps ?? null,
    );

    const run = runRef.current;
    run.count = verdict === run.verdict ? run.count + 1 : 1;
    run.verdict = verdict;

    setState({
      // Report the verdict only once it has held. A single bad 3-second window
      // — a passing wifi dip, someone else on the link starting a download —
      // must not move anyone's quality.
      health: run.count >= SUSTAIN_POLLS ? verdict : 'unknown',
      streak: run.count,
      latest: stats,
    });
  }, []);

  useEffect(() => {
    if (!isActive) return;

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      runRef.current = { verdict: 'unknown', count: 0 };
      setState({ health: 'unknown', streak: 0, latest: null });
    };
  }, [isActive, poll]);

  return state;
}
