import { logger } from '../services/logger';
import { useState, useCallback, useEffect, useRef } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { QualityLevel, QualityFeedback } from '../types';

const POLL_INTERVAL_MS = 3000; // 3 seconds

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
  /** Seconds of the interval the picture spent frozen. */
  freezeSeconds: number;
  /** Length of the interval, in seconds. */
  intervalSeconds: number;
}

// Subsets of the WebRTC stats dictionaries we read. RTCStatsReport entries are
// typed as `any` by the DOM lib, so we cast to these for checked field access
// instead of reaching through `any` at every property.
interface InboundRtpVideoStats {
  type?: string;
  kind?: string;
  ssrc?: number;
  packetsLost?: number;
  packetsReceived?: number;
  bytesReceived?: number;
  jitter?: number;
  framesPerSecond?: number;
  totalFreezesDuration?: number;
}

interface CandidatePairStats {
  state?: string;
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

  const fpsScore =
    expectedFps > 0 ? Math.min(100, (metrics.fps / (expectedFps * FPS_SLACK)) * 100) : 100;

  // A quarter of the window spent frozen is unusable, whatever else is true.
  const frozenFraction =
    metrics.intervalSeconds > 0 ? metrics.freezeSeconds / metrics.intervalSeconds : 0;
  const freezeScore = ramp(frozenFraction, 0, 0.25);

  return Math.max(0, Math.min(lossScore, jitterScore, rttScore, fpsScore, freezeScore));
}

export function scoreToLevel(score: number): QualityLevel {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  if (score >= 30) return 'poor';
  return 'critical';
}

/** Per-stream counters carried between polls so we can difference them. */
interface StreamSample {
  packetsLost: number;
  packetsReceived: number;
  bytesReceived: number;
  freezeDuration: number;
  at: number;
}

export function useQualityMonitor(
  isWatching: boolean,
  onQualityChange?: (feedback: QualityFeedback) => void
) {
  const [quality, setQuality] = useState<QualityLevel | null>(null);
  const [score, setScore] = useState<number | null>(null);
  const [metrics, setMetrics] = useState<QualityMetrics | null>(null);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const prevLevelRef = useRef<QualityLevel | null>(null);
  const samplesRef = useRef<Map<number, StreamSample>>(new Map());

  const pollStats = useCallback(async () => {
    try {
      const stats = await webrtcService.getStats();
      if (!stats) return;

      let rttMs = 0;
      const inbound: InboundRtpVideoStats[] = [];

      stats.forEach((report) => {
        const r = report as InboundRtpVideoStats;
        if (r.type === 'inbound-rtp' && r.kind === 'video') inbound.push(r);
        if (
          report.type === 'candidate-pair' &&
          (report as CandidatePairStats).state === 'succeeded'
        ) {
          rttMs = ((report as CandidatePairStats).currentRoundTripTime ?? 0) * 1000;
        }
      });

      const now = performance.now();
      const prev = samplesRef.current;
      const next = new Map<number, StreamSample>();

      // Score the stream carrying the most traffic *right now*.
      //
      // Watching a screen share means two inbound video streams — the share and
      // the peer's camera — and the old code overwrote fps and jitter with
      // whichever the iterator happened to reach last, while summing the packet
      // counters across both. It could report the 640x480 camera's frame rate as
      // the health of a screen share, or blend the two into a number describing
      // neither. The share is the bigger stream by a wide margin, so "most bytes
      // this interval" picks it out without needing to know which is which.
      let best: {
        stats: InboundRtpVideoStats;
        sample: StreamSample;
        prior: StreamSample;
      } | null = null;
      let bestDelta = 0;

      for (const r of inbound) {
        if (r.ssrc === undefined) continue;
        const sample: StreamSample = {
          packetsLost: r.packetsLost ?? 0,
          packetsReceived: r.packetsReceived ?? 0,
          bytesReceived: r.bytesReceived ?? 0,
          freezeDuration: r.totalFreezesDuration ?? 0,
          at: now,
        };
        next.set(r.ssrc, sample);

        const prior = prev.get(r.ssrc);
        if (!prior) continue;

        const delta = sample.bytesReceived - prior.bytesReceived;
        if (delta > bestDelta) {
          bestDelta = delta;
          best = { stats: r, sample, prior };
        }
      }

      samplesRef.current = next;

      // First poll of a connection, or nothing actually arriving. No opinion —
      // the same discipline as useUplinkEstimate, and for the same reason: a
      // guess here is worse than silence, because 'critical' is wired to an
      // action.
      if (!best) return;

      const intervalSeconds = Math.max((best.sample.at - best.prior.at) / 1000, 0.001);
      const newMetrics: QualityMetrics = {
        packetsLost: Math.max(0, best.sample.packetsLost - best.prior.packetsLost),
        packetsReceived: Math.max(0, best.sample.packetsReceived - best.prior.packetsReceived),
        jitterMs: (best.stats.jitter ?? 0) * 1000,
        rttMs,
        fps: best.stats.framesPerSecond ?? 0,
        freezeSeconds: Math.max(0, best.sample.freezeDuration - best.prior.freezeDuration),
        intervalSeconds,
      };

      setMetrics(newMetrics);

      const newScore = calculateQualityScore(newMetrics);
      const newLevel = scoreToLevel(newScore);

      setScore(Math.round(newScore));
      setQuality(newLevel);

      // Notify on level change (to send feedback to streamer)
      if (newLevel !== prevLevelRef.current && onQualityChange) {
        const total = newMetrics.packetsReceived + newMetrics.packetsLost;
        const feedback: QualityFeedback = {
          level: newLevel,
          score: Math.round(newScore),
          packetLossPercent: total > 0 ? (newMetrics.packetsLost / total) * 100 : 0,
          jitterMs: newMetrics.jitterMs,
          rttMs: newMetrics.rttMs,
          fps: newMetrics.fps,
        };
        onQualityChange(feedback);
      }

      prevLevelRef.current = newLevel;
    } catch (err) {
      logger.error('[QualityMonitor] Error polling stats:', err);
    }
  }, [onQualityChange]);

  useEffect(() => {
    if (isWatching) {
      pollStats(); // Initial poll — seeds the counters, reports nothing
      intervalRef.current = setInterval(pollStats, POLL_INTERVAL_MS);
    } else {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
        intervalRef.current = null;
      }
      setQuality(null);
      setScore(null);
      setMetrics(null);
      prevLevelRef.current = null;
      // Counters belong to one connection. Carrying them into the next call
      // would difference against a stream that no longer exists.
      samplesRef.current.clear();
    }

    return () => {
      if (intervalRef.current) {
        clearInterval(intervalRef.current);
      }
    };
  }, [isWatching, pollStats]);

  return {
    quality,
    score,
    metrics,
  };
}
