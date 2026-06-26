import { logger } from '../services/logger';
import { useState, useCallback, useEffect, useRef } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { QualityLevel, QualityFeedback } from '../types';

const POLL_INTERVAL_MS = 3000; // 3 seconds

interface QualityMetrics {
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  rttMs: number;
  fps: number;
  framesDropped: number;
}

// Subsets of the WebRTC stats dictionaries we read. RTCStatsReport entries are
// typed as `any` by the DOM lib, so we cast to these for checked field access
// instead of reaching through `any` at every property.
interface InboundRtpVideoStats {
  kind?: string;
  packetsLost?: number;
  packetsReceived?: number;
  jitter?: number;
  framesPerSecond?: number;
  framesDropped?: number;
}

interface CandidatePairStats {
  state?: string;
  currentRoundTripTime?: number;
}

function calculateQualityScore(metrics: QualityMetrics, expectedFps = 30): number {
  // Packet loss score (0-100, lower loss = higher score)
  const totalPackets = metrics.packetsReceived + metrics.packetsLost;
  const lossRate = totalPackets > 0 ? (metrics.packetsLost / totalPackets) * 100 : 0;
  const lossScore = Math.max(0, 100 - lossRate * 10); // 10% loss = 0 score

  // Jitter score (0-100, lower jitter = higher score)
  const jitterScore = Math.max(0, 100 - metrics.jitterMs * 2); // 50ms = 0 score

  // RTT score (0-100, lower RTT = higher score)
  const rttScore = Math.max(0, 100 - metrics.rttMs / 3); // 300ms = 0 score

  // FPS score (0-100, closer to expected = higher score)
  const fpsScore = expectedFps > 0 ? Math.min(100, (metrics.fps / expectedFps) * 100) : 100;

  // Weighted average
  return lossScore * 0.4 + jitterScore * 0.25 + rttScore * 0.2 + fpsScore * 0.15;
}

function scoreToLevel(score: number): QualityLevel {
  if (score >= 90) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 50) return 'fair';
  if (score >= 30) return 'poor';
  return 'critical';
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

  const pollStats = useCallback(async () => {
    try {
      const stats = await webrtcService.getStats();
      if (!stats) return;

      let packetsLost = 0;
      let packetsReceived = 0;
      let jitterMs = 0;
      let rttMs = 0;
      let fps = 0;
      let framesDropped = 0;

      stats.forEach((report) => {
        if (report.type === 'inbound-rtp' && (report as InboundRtpVideoStats).kind === 'video') {
          const r = report as InboundRtpVideoStats;
          packetsLost += r.packetsLost ?? 0;
          packetsReceived += r.packetsReceived ?? 0;
          jitterMs = (r.jitter ?? 0) * 1000;
          fps = r.framesPerSecond ?? 0;
          framesDropped = r.framesDropped ?? 0;
        }
        if (report.type === 'candidate-pair' && (report as CandidatePairStats).state === 'succeeded') {
          const cp = report as CandidatePairStats;
          rttMs = (cp.currentRoundTripTime ?? 0) * 1000;
        }
      });

      const newMetrics: QualityMetrics = {
        packetsLost,
        packetsReceived,
        jitterMs,
        rttMs,
        fps,
        framesDropped,
      };

      setMetrics(newMetrics);

      const newScore = calculateQualityScore(newMetrics);
      const newLevel = scoreToLevel(newScore);

      setScore(Math.round(newScore));
      setQuality(newLevel);

      // Notify on level change (to send feedback to streamer)
      if (newLevel !== prevLevelRef.current && onQualityChange) {
        const feedback: QualityFeedback = {
          level: newLevel,
          score: Math.round(newScore),
          packetLossPercent:
            packetsReceived + packetsLost > 0
              ? (packetsLost / (packetsReceived + packetsLost)) * 100
              : 0,
          jitterMs,
          rttMs,
          fps,
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
      pollStats(); // Initial poll
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
