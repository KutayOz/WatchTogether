import { useEffect, useRef } from 'react';

interface FilmLeaderProps {
  label: string;
  /** Smaller variant for inline use. */
  compact?: boolean;
}

/**
 * The countdown leader at the head of a film reel — 3, 2, 1 with the sweep
 * going round — used for the wait while a session connects. It loops for as
 * long as the wait lasts; the numbers are the leader's, not a promise about
 * how long joining takes.
 *
 * The sweep and the number are driven from one clock in one rAF, so they can
 * never drift out of step, and they write straight to the DOM rather than
 * re-rendering React sixty times a second.
 */
export function FilmLeader({ label, compact = false }: FilmLeaderProps) {
  const frameRef = useRef<HTMLDivElement>(null);
  const numRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const frame = frameRef.current;
    const num = numRef.current;
    if (!frame || !num) return;
    // The number is owned by this effect, not by React, so React never holds
    // a text node that this loop has replaced.
    num.textContent = '3';
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      frame.style.setProperty('--sweep', '270deg');
      return;
    }
    const start = performance.now();
    let raf = 0;
    let shown = '';
    const tick = (now: number) => {
      const elapsed = now - start;
      const angle = ((elapsed % 1000) / 1000) * 360;
      frame.style.setProperty('--sweep', `${angle.toFixed(1)}deg`);
      const n = String(3 - (Math.floor(elapsed / 1000) % 3));
      if (n !== shown) {
        shown = n;
        num.textContent = n;
        num.animate(
          [
            { opacity: 0.2, transform: 'scale(1.18)', filter: 'blur(6px)' },
            { opacity: 1, transform: 'scale(1)', filter: 'blur(0px)' },
          ],
          { duration: 360, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
        );
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <div className={['leader', compact && 'leader--compact'].filter(Boolean).join(' ')} role="status" aria-live="polite">
      <div className="leader__frame" ref={frameRef} aria-hidden="true">
        <div className="leader__sweep" />
        <svg className="leader__marks" viewBox="0 0 200 200">
          <circle cx="100" cy="100" r="92" />
          <circle cx="100" cy="100" r="70" />
          <path d="M100 0v200M0 100h200" />
        </svg>
        <span className="leader__num" ref={numRef} />
      </div>
      <p className="leader__label">{label}</p>
    </div>
  );
}
