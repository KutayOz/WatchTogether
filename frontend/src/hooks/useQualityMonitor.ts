import { logger } from '../services/logger';
import { useState, useEffect, useRef } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { QualityLevel, QualityFeedback } from '../types';

const POLL_INTERVAL_MS = 3000; // 3 seconds

/**
 * Re-send the current verdict this often, even when it has not changed.
 *
 * Feedback used to be edge-triggered only, and that quietly made the sender's
 * copy of it un-expirable: a viewer sitting at 'poor' sends once and then goes
 * silent, so the sender cannot tell "still bad" from "peer vanished" and has to
 * believe the last report forever. Repeating it turns the signal into state
 * replication, which is what lets the sender apply VIEWER_REPORT_TTL_MS and
 * recover on its own if the reports stop.
 *
 * Three polls, matching useSenderHealth's SUSTAIN_POLLS, so the two legs of the
 * loop learn at the same rate. The cost is one small data-channel message every
 * nine seconds.
 */
export const FEEDBACK_HEARTBEAT_MS = 9000;

/**
 * What one polling interval looked like to the viewer.
 *
 * Deltas, not running totals. The old code summed packetsLost and
 * packetsReceived from the start of the call, so a burst of loss in the first
 * ten seconds stayed in the denominator forever: a link that recovered never
 * looked recovered, and a link that went bad an hour in barely moved the
 * number.
 */
export interface QualityMetrics {
  /** Packets lost during the interval. */
  packetsLost: number;
  /** Packets received during the interval. */
  packetsReceived: number;
  jitterMs: number;
  rttMs: number;
  /** Frames per second the decoder is currently producing. */
  fps: number;
  /** False only when neither decoder counters nor instantaneous FPS exist. */
  fpsMeasured?: boolean;
  /** Seconds of the interval the picture spent frozen. */
  freezeSeconds: number;
  /** Length of the interval, in seconds. */
  intervalSeconds: number;
}

// Subsets of the WebRTC stats dictionaries we read. RTCStatsReport entries are
// typed as `any` by the DOM lib, so we cast to these for checked field access
// instead of reaching through `any` at every property.
interface InboundRtpVideoStats {
  id?: string;
  timestamp?: number;
  type?: string;
  kind?: string;
  mediaType?: string;
  trackIdentifier?: string;
  transportId?: string;
  ssrc?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  jitter?: number;
  framesPerSecond?: number;
  totalFreezesDuration?: number;
  frameWidth?: number;
  frameHeight?: number;
  freezeCount?: number;
  framesReceived?: number;
  framesDecoded?: number;
  framesDropped?: number;
  jitterBufferDelay?: number;
  jitterBufferEmittedCount?: number;
  pliCount?: number;
  nackCount?: number;
  decoderImplementation?: string;
}

/**
 * What the RECEIVER is getting, for the diagnostics panel.
 *
 * Separate from `QualityMetrics`, which is the scoring input and is
 * deliberately small. This is the readout, and it exists because every
 * diagnostic in this app was on the sender: the person watching a picture
 * freeze could see a coloured bar and nothing else, so a report could only ever
 * say "it looks choppy". A freeze count beside the sender's own
 * `qualityLimitationReason` turns the next one into a measurement.
 */
export interface InboundScreenStats {
  frameWidth: number | null;
  frameHeight: number | null;
  framesPerSecond: number | null;
  /** How many times the picture stopped, and for how long in total, in seconds. */
  freezeCount: number | null;
  totalFreezesDuration: number | null;
  framesReceived: number | null;
  framesDecoded: number | null;
  framesDropped: number | null;
  /** Cumulative; only meaningful against jitterBufferEmittedCount. See jitterBufferMs. */
  jitterBufferDelay: number | null;
  jitterBufferEmittedCount: number | null;
  /** Recovery traffic: a keyframe we had to ask for, and packets we had to chase. */
  pliCount: number | null;
  nackCount: number | null;
  decoderImplementation: string | null;
}

/**
 * Mean milliseconds a frame waited in the jitter buffer.
 *
 * The two counters are a RATIO, not a duration: `jitterBufferDelay` is seconds
 * summed over every frame emitted, so reading it on its own gives a number that
 * climbs forever. Dividing by `jitterBufferEmittedCount` is the whole trick,
 * and getting it wrong is the classic way to misread this statistic.
 *
 * null when either term is missing or nothing has been emitted yet.
 */
export function jitterBufferMs(s: InboundScreenStats | null): number | null {
  if (!s) return null;
  const { jitterBufferDelay: delay, jitterBufferEmittedCount: emitted } = s;
  if (typeof delay !== 'number' || typeof emitted !== 'number' || emitted <= 0) return null;
  return (delay / emitted) * 1000;
}

/** Pull the readout out of one inbound-rtp report. Every field independently optional. */
function readInbound(r: InboundRtpVideoStats): InboundScreenStats {
  return {
    frameWidth: r.frameWidth ?? null,
    frameHeight: r.frameHeight ?? null,
    framesPerSecond: r.framesPerSecond ?? null,
    freezeCount: r.freezeCount ?? null,
    totalFreezesDuration: r.totalFreezesDuration ?? null,
    framesReceived: r.framesReceived ?? null,
    framesDecoded: r.framesDecoded ?? null,
    framesDropped: r.framesDropped ?? null,
    jitterBufferDelay: r.jitterBufferDelay ?? null,
    jitterBufferEmittedCount: r.jitterBufferEmittedCount ?? null,
    pliCount: r.pliCount ?? null,
    nackCount: r.nackCount ?? null,
    decoderImplementation: r.decoderImplementation ?? null,
  };
}

interface CandidatePairStats {
  id?: string;
  state?: string;
  selected?: boolean;
  nominated?: boolean;
  currentRoundTripTime?: number;
}

/**
 * Frame rate is allowed to sit this far under nominal before it counts against
 * the score. Encoders routinely deliver 27 of 30 and there is nothing wrong
 * with that; reporting it as degraded would train people to ignore the badge.
 */
const FPS_SLACK = 0.85;

/** Linear 100 -> 0 as `value` travels from `good` to `bad`. */
function ramp(value: number, good: number, bad: number): number {
  if (value <= good) return 100;
  if (value >= bad) return 0;
  return 100 - ((value - good) / (bad - good)) * 100;
}

/**
 * How good the connection is, 0-100.
 *
 * The score drives exactly one decision — the auto-downgrade in SessionRoom,
 * which fires only on 'critical' — so it has to be able to *reach* critical on
 * each way a call actually fails.
 *
 * This is a MINIMUM, not the weighted average it used to be. The average let
 * every symptom hide behind the others: frame rate carried 15% of the weight,
 * so a stream frozen solid at 0 fps with clean packet counters scored 79 and
 * reported 'good'. That is the precise case users complained about, and the
 * downgrade never once saw it. A call is only as good as its worst dimension,
 * and a picture nobody can watch is not a healthy connection that happens to
 * have a low frame rate.
 *
 * Being a minimum also means each threshold below stands on its own and can be
 * read without holding the other four in your head.
 *
 * The one term that needs care is frame rate, and the care is in what gets
 * passed as `expectedFps` rather than in the arithmetic here — see the doc on
 * the hook's parameter. A receiver cannot tell a frame that was lost from a
 * frame that was never sent, so the yardstick has to come from the sender.
 */
export function calculateQualityScore(metrics: QualityMetrics, expectedFps = 30): number {
  const totalPackets = metrics.packetsReceived + metrics.packetsLost;
  const lossRate = totalPackets > 0 ? (metrics.packetsLost / totalPackets) * 100 : 0;

  // 5% loss is where video stops being watchable, not where it starts to look
  // soft — the old curve reached zero at 10% and called 10% loss 'fair'.
  const lossScore = ramp(lossRate, 0, 5);

  // Interactivity, not throughput. 60 ms of RTT is a fine call and should not
  // hold the score down; the old `100 - rtt/3` capped a healthy path at 80.
  const jitterScore = ramp(metrics.jitterMs, 20, 100);
  const rttScore = ramp(metrics.rttMs, 150, 500);

  // At one frame per second or less, independent sender/receiver windows
  // routinely straddle a still-frame update. Absence in this window is idle.
  const fpsScore =
    expectedFps > 1 && metrics.fpsMeasured !== false
      ? Math.min(100, (metrics.fps / (expectedFps * FPS_SLACK)) * 100) : 100;

  // A quarter of the window spent frozen is unusable, whatever else is true.
  const frozenFraction =
    metrics.intervalSeconds > 0 ? metrics.freezeSeconds / metrics.intervalSeconds : 0;
  // A still/paused capture legitimately stops producing frames. Browsers can
  // count that gap as a freeze even though every transmitted frame arrived.
  const freezeScore = expectedFps <= 1 ? 100 : ramp(frozenFraction, 0, 0.25);

  return Math.max(0, Math.min(lossScore, jitterScore, rttScore, fpsScore, freezeScore));
}

export function scoreToLevel(score: number): QualityLevel {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  if (score >= 30) return 'poor';
  return 'critical';
}

/** Counters from the selected track, never a blend of camera and screen. */
interface StreamSample {
  key: string;
  packetsLost: number;
  packetsReceived: number;
  bytesReceived: number;
  framesDecoded: number | undefined;
  freezeDuration: number;
  expectedFps: number | undefined;
  idleGeneration: number;
  at: number;
}

function streamKey(r: InboundRtpVideoStats): string {
  return `${r.id ?? ''}:${r.ssrc ?? ''}:${r.trackIdentifier ?? ''}`;
}

/** Follow the receiver's track identity, including when its traffic stops. */
function selectVideo(
  stats: RTCStatsReport,
  trackId: string | undefined,
  previousKey: string | undefined,
): InboundRtpVideoStats | undefined {
  const videos: InboundRtpVideoStats[] = [];
  stats.forEach((r: InboundRtpVideoStats) => {
    if (r.type === 'inbound-rtp' && (r.kind ?? r.mediaType) === 'video') videos.push(r);
  });
  const matching = trackId ? videos.filter((r) => r.trackIdentifier === trackId) : videos;
  // When identity is published, absence of the requested track is absence of
  // evidence. A camera report must never substitute for a missing screen.
  if (trackId && matching.length === 0 && videos.some((r) => r.trackIdentifier)) return;
  const candidates = matching.length ? matching : videos;
  const previous = candidates.find((r) => streamKey(r) === previousKey);
  if (previous) return previous;
  // Compatibility for browsers without trackIdentifier: choose the largest
  // picture once and keep following it, even while a camera sends more bytes.
  return candidates.sort((a, b) =>
    ((b.frameWidth ?? 0) * (b.frameHeight ?? 0) - (a.frameWidth ?? 0) * (a.frameHeight ?? 0)) ||
    ((b.bytesReceived ?? 0) - (a.bytesReceived ?? 0)),
  )[0];
}

function selectedRtt(stats: RTCStatsReport, transportId: string | undefined): number {
  let selectedPairId: string | undefined;
  let fallback: CandidatePairStats | undefined;
  stats.forEach((r) => {
    if (r.type === 'transport' && (!transportId || r.id === transportId)) {
      selectedPairId = r.selectedCandidatePairId ?? selectedPairId;
    } else if (r.type === 'candidate-pair' && r.state === 'succeeded' && (r.selected || r.nominated)) {
      fallback = r;
    }
  });
  const selected = selectedPairId ? stats.get(selectedPairId) as CandidatePairStats | undefined : undefined;
  return ((selected ?? fallback)?.currentRoundTripTime ?? 0) * 1000;
}

/**
 * @param expectedFps The frame rate the SENDER says it is putting on the wire,
 *   or undefined when it has not said.
 *
 *   Two corrections live in this one number, and the second is much larger than
 *   the first. Judging a 24 fps film share against the 30 fps default made a
 *   healthy stream look 6% short of nominal for its whole run — not enough to
 *   reach a bad verdict alone, but enough to narrow the margin on a signal that
 *   is wired to an action. Judging a STILL screen against its ask was the same
 *   error at thirty times the size: `getDisplayMedia` produces about one frame
 *   a second when nothing on screen moves, and 1 against 30 scores 3.9 in a
 *   function that takes a minimum. The viewer reported 'critical' every nine
 *   seconds, and the sender answered by cutting its budget from 1.9 Mbps to
 *   250 kbps on a path measuring 4.7.
 *
 *   Which is why this is `ShareStatus.sentFps` and not `ShareStatus.fps`. The
 *   question a receiver can actually answer is "did I get what was sent", and
 *   whether enough was sent is the sender's own to answer — it has
 *   `source-idle`, `cpu-bound` and `under-served` for exactly that.
 */
export function useQualityMonitor(
  isWatching: boolean,
  onQualityChange?: (feedback: QualityFeedback) => void,
  expectedFps?: number,
  trackId?: string,
) {
  const [quality, setQuality] = useState<QualityLevel | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const [inbound, setInbound] = useState<InboundScreenStats | null>(null);
  // Telemetry/callback changes must not restart the sampling interval. Track
  // changes do: counters and in-flight promises belong to that exact stream.
  const inputs = useRef({ expectedFps, onQualityChange, idleGeneration: 0 });
  useEffect(() => {
    const previous = inputs.current;
    // A pause may begin and end between two receiver polls. Remember that
    // transition so its partial frame window is not treated as packet loss.
    const enteredIdle = expectedFps !== undefined && expectedFps <= 1 &&
      (previous.expectedFps === undefined || previous.expectedFps > 1);
    inputs.current = { expectedFps, onQualityChange,
      idleGeneration: previous.idleGeneration + (enteredIdle ? 1 : 0) };
  }, [expectedFps, onQualityChange]);

  useEffect(() => {
    setQuality(null);
    setScore(null);
    setMetrics(null);
    setInbound(null);
    if (!isWatching) return;

    let active = true;
    let pending = false;
    let previous: StreamSample | undefined;
    let previousLevel: QualityLevel | null = null;
    let lastSentAt = -Infinity;

    async function pollStats() {
      // Slow getStats calls must not overlap and complete out of order.
      if (pending) return;
      pending = true;
      try {
        const stats = await webrtcService.getStats();
        if (!active || !stats) return;
        const report = selectVideo(stats, trackId, previous?.key);
        if (!report) {
          previous = undefined;
          setQuality(null);
          setScore(null);
          setMetrics(null);
          setInbound(null);
          return;
        }
        const now = performance.now();
        const { expectedFps: expected, onQualityChange: notify, idleGeneration } = inputs.current;
        const sample: StreamSample = {
          key: streamKey(report),
          packetsLost: report.packetsLost ?? 0,
          packetsReceived: report.packetsReceived ?? 0,
          bytesReceived: report.bytesReceived ?? 0,
          framesDecoded: report.framesDecoded,
          freezeDuration: report.totalFreezesDuration ?? 0,
          expectedFps: expected,
          idleGeneration,
          at: report.timestamp ?? now,
        };
        const prior = previous;
        if (prior?.key === sample.key && sample.at <= prior.at) return;
        previous = sample;
        setInbound(readInbound(report));
        // A restarted receiver may reuse an SSRC. Never interpret a counter
        // reset (or a new report id with that SSRC) as zero delivery.
        if (!prior || sample.key !== prior.key ||
          sample.bytesReceived < prior.bytesReceived ||
          sample.packetsReceived < prior.packetsReceived ||
          sample.freezeDuration < prior.freezeDuration ||
          (sample.framesDecoded !== undefined && prior.framesDecoded !== undefined &&
            sample.framesDecoded < prior.framesDecoded)) {
          setQuality(null);
          setScore(null);
          setMetrics(null);
          previousLevel = null;
          lastSentAt = -Infinity;
          return;
        }
        const intervalSeconds = (sample.at - prior.at) / 1000;
        const measuredFps = sample.framesDecoded !== undefined && prior.framesDecoded !== undefined
          ? (sample.framesDecoded - prior.framesDecoded) / intervalSeconds
          : report.framesPerSecond;
        // A freeze duration can be published only when playback resumes. Do
        // not blame a just-ended, intentionally paused source on the network.
        const resumedFromIdle = (prior.expectedFps !== undefined && prior.expectedFps <= 1) ||
          prior.idleGeneration !== sample.idleGeneration;
        const newMetrics: QualityMetrics = {
          packetsLost: Math.max(0, sample.packetsLost - prior.packetsLost),
          packetsReceived: sample.packetsReceived - prior.packetsReceived,
          jitterMs: (report.jitter ?? 0) * 1000,
          rttMs: selectedRtt(stats, report.transportId),
          fps: measuredFps ?? 0,
          ...(measuredFps === undefined ? { fpsMeasured: false } : {}),
          freezeSeconds: resumedFromIdle ? 0 : Math.max(0, sample.freezeDuration - prior.freezeDuration),
          intervalSeconds,
        };
        // Missing FPS is unknown, not a zero-frame decoder. Counter-derived
        // FPS works on browsers that omit the instantaneous framesPerSecond.
        // This window contains a known source pause. Its decoded FPS cannot
        // be compared with the sender's now-resumed instantaneous FPS. Keep
        // transport loss/jitter/RTT scoring active; only frame terms get grace.
        const newScore = calculateQualityScore(newMetrics, resumedFromIdle ? 1 : expected);
        const newLevel = scoreToLevel(newScore);
        setMetrics(newMetrics);
        setScore(Math.round(newScore));
        setQuality(newLevel);
        if (report.framesPerSecond === undefined && measuredFps !== undefined) {
          setInbound({ ...readInbound(report), framesPerSecond: measuredFps });
        }

        const due = now - lastSentAt >= FEEDBACK_HEARTBEAT_MS;
        if (notify && (newLevel !== previousLevel || due)) {
          lastSentAt = now;
          const total = newMetrics.packetsReceived + newMetrics.packetsLost;
          const picture = typeof report.frameWidth === 'number' && report.frameWidth > 0 &&
            typeof report.frameHeight === 'number' && report.frameHeight > 0
            ? { width: report.frameWidth, height: report.frameHeight } : null;
          notify({
            level: newLevel,
            score: Math.round(newScore),
            packetLossPercent: total > 0 ? (newMetrics.packetsLost / total) * 100 : 0,
            jitterMs: newMetrics.jitterMs,
            rttMs: newMetrics.rttMs,
            fps: newMetrics.fps,
            ...(picture ? { picture } : {}),
          });
        }
        previousLevel = newLevel;
      } catch (err) {
        if (active) logger.error('[QualityMonitor] Error polling stats:', err);
      } finally {
        pending = false;
      }
    }

    void pollStats();
    const interval = setInterval(() => { void pollStats(); }, POLL_INTERVAL_MS);
    return () => {
      active = false;
      clearInterval(interval);
    };
  }, [isWatching, trackId]);

  return { quality, score, metrics, inbound };
}
