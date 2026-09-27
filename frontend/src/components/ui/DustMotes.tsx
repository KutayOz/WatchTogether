import { useEffect, useRef } from 'react';

interface Mote {
  x: number;
  y: number;
  vx: number;
  vy: number;
  r: number;
  phase: number;
  twinkle: number;
}

/** Half-angle of the projector beam, in radians. Matches .beam in theater.css. */
const HALF_ANGLE = (27 * Math.PI) / 180;
const FRAME_MS = 1000 / 30;

/**
 * Dust hanging in the projector beam.
 *
 * The motes fill the whole viewport but are only lit while they drift through
 * the cone of light coming up from behind you toward the screen, so they
 * glint in and out of the beam the way real dust does. The cone's apex and
 * angle mirror the CSS beam; nothing else ties the two together.
 */
export function DustMotes({ count = 70 }: { count?: number }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let width = 0;
    let height = 0;
    let dpr = 1;
    let raf = 0;
    let last = 0;
    let t = 0;
    let motes: Mote[] = [];

    const seed = () => {
      motes = Array.from({ length: count }, () => ({
        x: Math.random() * width,
        y: Math.random() * height,
        vx: (Math.random() - 0.5) * 6,
        vy: -2 - Math.random() * 7,
        r: 0.5 + Math.random() * 1.5,
        phase: Math.random() * Math.PI * 2,
        twinkle: 0.6 + Math.random() * 1.6,
      }));
    };

    const resize = () => {
      dpr = Math.min(1.5, window.devicePixelRatio || 1);
      width = window.innerWidth;
      height = window.innerHeight;
      canvas.width = Math.round(width * dpr);
      canvas.height = Math.round(height * dpr);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      if (motes.length === 0) seed();
      draw();
    };

    // 1 inside the beam, easing to 0 across its soft edge.
    const lit = (x: number, y: number) => {
      const ax = width / 2;
      const ay = height * 1.15;
      const dx = x - ax;
      const dy = ay - y;
      if (dy <= 0) return 0;
      const angle = Math.abs(Math.atan2(dx, dy));
      const edge = HALF_ANGLE;
      if (angle >= edge) return 0;
      const inner = edge * 0.55;
      if (angle <= inner) return 1;
      const k = 1 - (angle - inner) / (edge - inner);
      return k * k * (3 - 2 * k);
    };

    const draw = () => {
      ctx.clearRect(0, 0, width, height);
      for (const m of motes) {
        const beam = lit(m.x, m.y);
        if (beam <= 0.01) continue;
        const shimmer = 0.55 + 0.45 * Math.sin(m.phase + t * m.twinkle);
        const alpha = beam * shimmer * 0.55;
        ctx.beginPath();
        ctx.fillStyle = `rgba(255,240,228,${alpha.toFixed(3)})`;
        ctx.arc(m.x, m.y, m.r, 0, Math.PI * 2);
        ctx.fill();
      }
    };

    const step = (dt: number) => {
      t += dt;
      for (const m of motes) {
        // Brownian nudge, then drift. Dust never goes in a straight line.
        m.vx += (Math.random() - 0.5) * 4 * dt;
        m.vy += (Math.random() - 0.5) * 4 * dt;
        m.vx = Math.max(-8, Math.min(8, m.vx));
        m.vy = Math.max(-10, Math.min(3, m.vy));
        m.x += m.vx * dt;
        m.y += m.vy * dt;
        if (m.y < -10) m.y = height + 10;
        if (m.y > height + 10) m.y = -10;
        if (m.x < -10) m.x = width + 10;
        if (m.x > width + 10) m.x = -10;
      }
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : FRAME_MS / 1000;
      last = now;
      step(dt);
      draw();
    };

    const onVisibility = () => {
      cancelAnimationFrame(raf);
      if (!document.hidden && !reduce) {
        last = 0;
        raf = requestAnimationFrame(loop);
      }
    };

    resize();
    window.addEventListener('resize', resize);
    document.addEventListener('visibilitychange', onVisibility);
    if (!reduce) raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('resize', resize);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [count]);

  return <canvas ref={canvasRef} className="dust" aria-hidden="true" />;
}
