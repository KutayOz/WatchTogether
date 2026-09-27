import { useEffect, useRef } from 'react';

const GLYPHS = 'abcdefghijkmnopqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ23456789-_';

interface ScrambleTextProps {
  text: string;
  className?: string;
  /** Milliseconds for the whole reveal. */
  duration?: number;
}

/**
 * Text that decodes itself left to right, the characters ahead of the reveal
 * cycling through noise. Used for freshly minted links — the one moment the
 * app hands over something secret-ish, so it arrives like it was just cut.
 *
 * Seven tenths of a second, then it is plain text like any other. The DOM
 * text is owned by the effect, not by React, so React never holds a text node
 * the animation has replaced.
 */
export function ScrambleText({ text, className, duration = 700 }: ScrambleTextProps) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      el.textContent = text;
      return;
    }
    const start = performance.now();
    let raf = 0;
    const tick = (now: number) => {
      const p = Math.min(1, (now - start) / duration);
      const revealed = Math.floor(p * text.length);
      let out = text.slice(0, revealed);
      for (let i = revealed; i < text.length; i++) {
        const c = text[i];
        out += c === '/' || c === '.' || c === ':' ? c : GLYPHS[(Math.random() * GLYPHS.length) | 0];
      }
      el.textContent = out;
      if (p < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => {
      cancelAnimationFrame(raf);
      el.textContent = text;
    };
  }, [text, duration]);

  return <span ref={ref} className={className} />;
}
