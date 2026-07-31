import { useCallback, useEffect, useRef, useState } from 'react';
import { webrtcService } from '../services/webrtcService';
import { QUALITY_PRESETS, type ScreenShareQuality, type UplinkEstimate } from '../types';

/**
 * How much uplink the browser thinks it has, read off the peer connection.
 *
 * Replaces the speed test, which POSTed 256 KB to the API every five minutes
 * and asked how fast it arrived. That question stopped being useful the moment
 * the backend moved to Cloudflare: a Worker answers from the nearest edge, a
 * few milliseconds away, so the measurement described the path to Cloudflare
 * and not the path to the person you are actually streaming to. It would have
 * reported an enormous uplink for everybody and unlocked every preset — worst
 * for exactly the users whose links cannot carry them.
 *
 * `availableOutgoingBitrate` is the bandwidth estimator's own view of the real
 * path, updated continuously from what the connection is actually achieving.
 * It costs no requests, no CPU and no round trips, because the connection is
 * already computing it.
 */

const POLL_INTERVAL_MS = 3000;

/**
 * Samples kept for the median. Six samples at 3 s is roughly the last twenty
 * seconds — long enough that one bad estimate cannot drop someone's quality,
 * short enough to react before a struggling link has been stuttering for a
 * minute.
 */
const WINDOW = 6;

/**
 * Report nothing until the window is full. The estimator's first readings
 * after a connection comes up are wild, and clamping on them would drop
 * quality at the exact moment the call starts.
 */
const MIN_SAMPLES = WINDOW;

/**
 * Fraction of the estimate a stream is allowed to claim.
 *
 * Not 1.0, for two reasons: running a link at its estimated ceiling is how you
 * get queueing delay rather than throughput, and the screen share is never the
 * only thing on the wire — camera video, audio and the data channel are all
 * sharing it.
 */
const HEADROOM = 0.8;

interface CandidatePairStats {
  state?: string;
  nominated?: boolean;
  availableOutgoingBitrate?: number;
}

/** Total bits per second a preset asks for, video and audio together. */
function presetBitrate(quality: ScreenShareQuality): number {
  const preset = QUALITY_PRESETS[quality];
  return preset.video.bitrate + preset.audio.bitrate;
}

/**
 * Turn a bitrate estimate into "which presets fit".
 *
 * Exported because this is the part with the judgement in it, and a pure
 * function of one number is worth testing directly rather than through a
 * polling hook.
 */
export function estimateFromBitrate(bitsPerSecond: number): UplinkEstimate {
  const budget = bitsPerSecond * HEADROOM;
  const supportedQualities = {} as Record<ScreenShareQuality, boolean>;

  for (const key of Object.keys(QUALITY_PRESETS) as ScreenShareQuality[]) {
    // `auto` sets no ceiling and lets the encoder track the estimator itself,
    // so it fits by definition — and it is the honest answer on a link too
    // slow for even the lowest fixed preset.
    supportedQualities[key] = key === 'auto' || presetBitrate(key) <= budget;
  }

  // The best fixed preset that fits. Ordered explicitly rather than by
  // Object.keys, because "cheapest first" is a property of this list and not
  // of the object literal's declaration order.
  const ladder: ScreenShareQuality[] = ['low', 'medium', 'high', 'ultra', 'extreme'];
  const affordable = ladder.filter((key) => supportedQualities[key]);

  return {
    uplinkMbps: Math.round((bitsPerSecond / 1_000_000) * 10) / 10,
    // Nothing fixed fits: hand back `auto` so the encoder adapts downward
    // instead of the UI recommending a preset that cannot be sustained.
    recommendedQuality: affordable.at(-1) ?? 'auto',
    supportedQualities,
  };
}

/** Middle value, so one outlier in either direction cannot move the result. */
function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}

/**
 * Pull the estimate off the active candidate pair.
 *
 * Returns null when the browser does not publish one — Firefox does not
 * implement `availableOutgoingBitrate` — and null must mean "do not clamp",
 * never "clamp to the lowest". A guess is worse than no opinion here: it would
 * silently cap quality for every user of a browser that simply declines to
 * answer the question.
 */
function readOutgoingBitrate(stats: RTCStatsReport): number | null {
  let found: number | null = null;

  stats.forEach((report) => {
    if (report.type !== 'candidate-pair') return;
    const pair = report as CandidatePairStats;
    if (pair.state !== 'succeeded') return;
    if (typeof pair.availableOutgoingBitrate !== 'number') return;
    // More than one pair can be in 'succeeded'; the nominated one carries the
    // traffic. Prefer it, but take any succeeded pair over nothing.
    if (found === null || pair.nominated) found = pair.availableOutgoingBitrate;
  });

  return found;
}

export function useUplinkEstimate(isActive: boolean): UplinkEstimate | null {
  const [estimate, setEstimate] = useState<UplinkEstimate | null>(null);
  const samplesRef = useRef<number[]>([]);
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const poll = useCallback(async () => {
    const stats = await webrtcService.getStats();
    if (!stats) return;

    const bitrate = readOutgoingBitrate(stats);
    if (bitrate === null) return;

    const samples = [...samplesRef.current, bitrate].slice(-WINDOW);
    samplesRef.current = samples;
    if (samples.length < MIN_SAMPLES) return;

    setEstimate(estimateFromBitrate(median(samples)));
  }, []);

  useEffect(() => {
    if (!isActive) return;

    void poll();
    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    // Teardown rather than an `else` branch: clearing on the way out means the
    // next call starts from nothing, without a synchronous setState in the
    // effect body on every render where isActive is already false.
    //
    // Samples belong to one connection — carrying them forward would judge a
    // new link by the old one's behaviour — and the estimate goes with them,
    // because a stale number is what would clamp the next call before its own
    // window has filled.
    return () => {
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      samplesRef.current = [];
      setEstimate(null);
    };
  }, [isActive, poll]);

  return estimate;
}
