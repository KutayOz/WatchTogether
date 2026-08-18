import { useCallback, useEffect, useRef, useState } from 'react';
import { webrtcService } from '../services/webrtcService';
import type { OutboundScreenStats, TransportPath } from '../types';

/**
 * What the connection is actually doing, as opposed to what it was configured
 * to do.
 *
 * This exists because every quality decision in the app was being made against
 * numbers nobody had ever seen on a real link — DEPLOYMENT.md's "Known gaps"
 * says as much. Two questions in particular had no answer from inside the app:
 * whether the media is peer-to-peer or relayed through TURN, and whether the
 * encoder is getting the bitrate it was given or is quietly limited.
 *
 * Same 3 s cadence as useUplinkEstimate and useQualityMonitor, and the same
 * shape: one hook, one concern, null when there is nothing honest to report.
 */

const POLL_INTERVAL_MS = 3000;

export interface TransportDiagnostics {
  path: TransportPath | null;
  outbound: OutboundScreenStats | null;
  /**
   * Bits per pixel per frame — bitrate / (width * height * fps).
   *
   * The scoreboard for the whole quality effort. Resolution alone is
   * misleading: 1080p at 0.026 bpp looks worse than 900p at 0.046, because the
   * second one has half again as many bits to describe each pixel. Roughly:
   * >= 0.035 looks good on VP9 motion content, 0.025-0.035 is acceptable,
   * below 0.02 is visibly soft.
   *
   * Only meaningful AT THE INTENDED FRAME RATE. bpp divides by the frame rate
   * actually achieved, so an encoder that has collapsed to 1 fps reports a bpp
   * far ABOVE target while showing a slideshow — the reported failure read
   * `344x182 @ 1 · 0.479 bpp`, thirteen times target. Read it beside the
   * operating point that was asked for, never alone.
   *
   * null when any input is missing — never a partial estimate.
   */
  bpp: number | null;
}

/** Bits per pixel per frame, or null if any term is missing or degenerate. */
export function computeBpp(s: OutboundScreenStats | null): number | null {
  if (!s) return null;
  const { targetBitrate, frameWidth, frameHeight, framesPerSecond } = s;
  if (
    typeof targetBitrate !== 'number' ||
    typeof frameWidth !== 'number' ||
    typeof frameHeight !== 'number' ||
    typeof framesPerSecond !== 'number'
  ) {
    return null;
  }
  const pixelsPerSecond = frameWidth * frameHeight * framesPerSecond;
  if (pixelsPerSecond <= 0) return null;
  return targetBitrate / pixelsPerSecond;
}

export function useTransportDiagnostics(isActive: boolean): TransportDiagnostics {
  // One state object, not two: the path and the encoder readout are always
  // written together, and splitting them would render twice per poll.
  const [sample, setSample] = useState<{
    path: TransportPath | null;
    outbound: OutboundScreenStats | null;
  }>({ path: null, outbound: null });
  const intervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const activeRef = useRef(false);

  const poll = useCallback(async () => {
    // Both are independent reads; a failure in one must not blank the other.
    const [path, outbound] = await Promise.all([
      webrtcService.getTransportPath().catch(() => null),
      webrtcService.getOutboundScreenStats().catch(() => null),
    ]);
    // The connection can be torn down across the await; writing then would
    // resurrect a dead reading on the next call.
    if (!activeRef.current) return;
    setSample({ path, outbound });
  }, []);

  useEffect(() => {
    if (!isActive) return;
    activeRef.current = true;

    intervalRef.current = setInterval(() => void poll(), POLL_INTERVAL_MS);

    // Clear on the way out rather than branching on !isActive: a stale path
    // from the previous connection is exactly the kind of thing that would be
    // read as fact on the next one.
    return () => {
      activeRef.current = false;
      if (intervalRef.current) clearInterval(intervalRef.current);
      intervalRef.current = null;
      setSample({ path: null, outbound: null });
    };
  }, [isActive, poll]);

  return { path: sample.path, outbound: sample.outbound, bpp: computeBpp(sample.outbound) };
}

/** Short human label for the path, e.g. "P2P (udp)" or "relayed (turn/udp)". */
export function formatTransportPath(path: TransportPath | null): string | null {
  if (!path) return null;
  if (path.isRelayed) {
    return `relayed (turn/${path.relayProtocol ?? path.protocol})`;
  }
  const direct = path.local === 'host' && path.remote === 'host';
  return `${direct ? 'direct' : 'P2P'} (${path.protocol})`;
}
