import { useEffect, type RefObject } from 'react';

let sharedContext: AudioContext | null = null;

/**
 * One AudioContext for every meter in the app. Browsers cap how many can
 * exist, and each one is a real audio thread.
 */
function audioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  if (!sharedContext) {
    const Ctor =
      window.AudioContext ??
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return null;
    sharedContext = new Ctor();
  }
  if (sharedContext.state === 'suspended') void sharedContext.resume().catch(() => {});
  return sharedContext;
}

const FRAME_MS = 1000 / 30;

/**
 * How loud a stream is right now, written as `--level` (0..1) on an element —
 * the tiles use it to glow when someone speaks.
 *
 * Straight to style, never through React state: a level changes thirty times
 * a second, and routing that through a render would repaint the whole call.
 * Fast attack, slow release, so the glow jumps with a syllable and fades
 * between words instead of flickering.
 *
 * Measures the track as delivered — a muted local mic (track.enabled = false)
 * is silence, which is exactly what the other person hears.
 */
export function useAudioLevel(
  stream: MediaStream | null | undefined,
  targetRef: RefObject<HTMLElement | null>,
): void {
  useEffect(() => {
    const target = targetRef.current;
    const track = stream?.getAudioTracks()[0];
    if (!target) return;
    target.style.setProperty('--level', '0');
    if (!track || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const ctx = audioContext();
    if (!ctx) return;

    let source: MediaStreamAudioSourceNode;
    try {
      source = ctx.createMediaStreamSource(new MediaStream([track]));
    } catch {
      return;
    }
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 512;
    analyser.smoothingTimeConstant = 0.3;
    source.connect(analyser);
    const buf = new Uint8Array(analyser.fftSize);

    let raf = 0;
    let last = 0;
    let level = 0;
    let written = -1;

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < FRAME_MS) return;
      last = now;
      analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (let i = 0; i < buf.length; i++) {
        const v = (buf[i] - 128) / 128;
        sum += v * v;
      }
      // Speech RMS rarely passes 0.3, so scale into a range that fills.
      const rms = Math.min(1, Math.sqrt(sum / buf.length) * 4);
      level = rms > level ? level + (rms - level) * 0.6 : level + (rms - level) * 0.12;
      const rounded = Math.round(level * 50) / 50;
      if (rounded !== written) {
        written = rounded;
        target.style.setProperty('--level', String(rounded));
      }
    };

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden) raf = requestAnimationFrame(tick);
    };

    raf = requestAnimationFrame(tick);
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      cancelAnimationFrame(raf);
      document.removeEventListener('visibilitychange', onVisibility);
      try {
        source.disconnect();
      } catch {
        // already gone with its track
      }
      target.style.setProperty('--level', '0');
    };
  }, [stream, targetRef]);
}
