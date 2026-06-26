import { useEffect, useRef } from 'react';

interface UseTalkingWhileMutedOptions {
  /** The local user's media stream (camera + mic). Hook is no-op while null. */
  localStream: MediaStream | null;
  /** Whether the user is currently muted. Detection only runs while true. */
  isMuted: boolean;
  /** Fired when we're confident the user is talking into a muted mic. */
  onDetected: () => void;

  /**
   * RMS amplitude above which a frame counts as "speaking."
   *
   *   ~0.02  background hum / fan noise  (false positive territory)
   *   ~0.05  normal indoor speech         (sane default)
   *   ~0.10  clearly projected voice
   *   ~0.15  raised voice / shouting
   *
   * Lower = more sensitive (more false positives on cough/keyboard);
   * higher = misses quiet talkers.
   */
  rmsThreshold?: number;

  /**
   * Continuous duration above rmsThreshold required before firing.
   * Too short → sneezes and door slams trigger the warning;
   * too long → user already finished their first sentence before they know.
   */
  minDurationMs?: number;

  /**
   * Minimum gap between two firings. Without it, every breath after a
   * cleared warning re-fires the toast and the user wants to throw their
   * laptop out a window. 30 s is the Zoom/Meet default region.
   */
  cooldownMs?: number;
}

/**
 * Detects the universal video-call gaffe: "you're on mute" mid-sentence.
 *
 * How it works:
 *   1. While muted, attach an AnalyserNode to the audio track and sample
 *      RMS amplitude on requestAnimationFrame (~60 Hz).
 *   2. Track the timestamp of the first frame that crosses the threshold.
 *      If the user stays above the threshold for minDurationMs continuously,
 *      that's our "they're actually talking" signal.
 *   3. After firing, suppress further fires for cooldownMs so we don't
 *      become the thing the user wants to mute.
 *
 * Why the local stream and not the peer connection's audio sender:
 *   When muted, our toggleAudio path sets track.enabled = false. The track
 *   is still capturing samples — it's just not being SENT. So the local
 *   AnalyserNode still sees the user's voice and can detect the mistake.
 *   Reading the sender's outbound stats wouldn't work; the encoder is
 *   getting silenced frames.
 */
export function useTalkingWhileMuted({
  localStream,
  isMuted,
  onDetected,
  rmsThreshold = 0.05,
  minDurationMs = 500,
  cooldownMs = 30000,
}: UseTalkingWhileMutedOptions): void {
  // onDetected is allowed to change identity — we hold it in a ref so the
  // analyser effect doesn't tear down + rebuild on every parent re-render.
  const onDetectedRef = useRef(onDetected);
  useEffect(() => {
    onDetectedRef.current = onDetected;
  }, [onDetected]);

  useEffect(() => {
    if (!localStream || !isMuted) return;

    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;

    // AudioContext can vary by vendor on older Safari — fall back if needed.
    const Ctx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;

    const ctx = new Ctx();
    const source = ctx.createMediaStreamSource(new MediaStream([audioTrack]));
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 256;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.frequencyBinCount);

    let raf = 0;
    let closed = false;
    let runStartedAt: number | null = null;
    let lastFiredAt = 0;

    const tick = () => {
      if (closed) return;
      analyser.getByteTimeDomainData(buf);
      let sumSquares = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sumSquares += v * v;
      }
      const rms = Math.sqrt(sumSquares / buf.length);
      const now = performance.now();

      if (rms >= rmsThreshold) {
        // First frame of a potential talking-run — anchor the timer.
        if (runStartedAt === null) runStartedAt = now;
        // Long enough run + outside cooldown → fire.
        if (
          now - runStartedAt >= minDurationMs &&
          now - lastFiredAt >= cooldownMs
        ) {
          lastFiredAt = now;
          // Reset the run so a single long monologue doesn't refire the
          // instant cooldown elapses — we want a fresh threshold crossing.
          runStartedAt = null;
          onDetectedRef.current();
        }
      } else {
        // Dropped below threshold — abandon the current run.
        runStartedAt = null;
      }

      raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);

    return () => {
      closed = true;
      cancelAnimationFrame(raf);
      source.disconnect();
      ctx.close().catch(() => {});
    };
    // onDetected intentionally excluded — read via ref to avoid restarts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [localStream, isMuted, rmsThreshold, minDurationMs, cooldownMs]);
}
