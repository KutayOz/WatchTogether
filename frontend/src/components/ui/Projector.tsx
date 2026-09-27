import { useEffect, useRef } from 'react';

interface ProjectorProps {
  className?: string;
  /**
   * Let your light follow the cursor while it is over the screen. Theirs keeps
   * drifting on its own — you can chase it, you cannot steer it.
   */
  interactive?: boolean;
  /** Turn the lamp up until the screen washes out — the "starting" moment. */
  flare?: boolean;
  /**
   * Where the two lights are, horizontally, as 0..1 — about fifteen times a
   * second. Lets the page throw matching light into the room below.
   */
  onLights?: (amberX: number, tealX: number) => void;
}

const AMBER: [number, number, number] = [255, 181, 71];
const TEAL: [number, number, number] = [90, 212, 230];
const FRAME_MS = 1000 / 30;

/**
 * The screen, before anything is playing on it: two soft lights drifting
 * across a dark picture. Composited with `screen`, so where they overlap the
 * picture goes to warm white.
 *
 * Rendered at half resolution on purpose. It is all soft falloff, which
 * upscales invisibly, and it quarters the fill cost. Capped at 30 fps,
 * stopped entirely when off screen or in a background tab, and drawn exactly
 * once for anyone who prefers reduced motion.
 */
export function Projector({ className, interactive = false, flare = false, onLights }: ProjectorProps) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const flareRef = useRef(flare);
  const onLightsRef = useRef(onLights);

  useEffect(() => {
    flareRef.current = flare;
  }, [flare]);
  useEffect(() => {
    onLightsRef.current = onLights;
  }, [onLights]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    let width = 0;
    let height = 0;
    let raf = 0;
    let visible = true;
    let running = false;
    let last = 0;
    let lastReport = 0;
    let t = Math.random() * 40;
    let flareLevel = 0;

    const amber = { x: 0.34, y: 0.52 };
    const teal = { x: 0.66, y: 0.48 };
    let pointer: { x: number; y: number } | null = null;

    const resize = () => {
      // Layout size, not getBoundingClientRect: the screen scales open from a
      // line on mount, and a transformed rect would size the canvas to a sliver.
      const scale = Math.min(1, window.devicePixelRatio || 1) * 0.5;
      width = Math.max(2, Math.round(canvas.clientWidth * scale));
      height = Math.max(2, Math.round(canvas.clientHeight * scale));
      canvas.width = width;
      canvas.height = height;
      draw();
    };

    const light = (x: number, y: number, r: number, rgb: [number, number, number], a: number) => {
      const g = ctx.createRadialGradient(x, y, 0, x, y, r);
      const [cr, cg, cb] = rgb;
      g.addColorStop(0, `rgba(${cr},${cg},${cb},${a})`);
      g.addColorStop(0.38, `rgba(${cr},${cg},${cb},${a * 0.52})`);
      g.addColorStop(0.7, `rgba(${cr},${cg},${cb},${a * 0.14})`);
      g.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, width, height);
    };

    const draw = () => {
      if (!width || !height) return;
      // The black level of a screen, a touch lifted in the middle.
      ctx.globalCompositeOperation = 'source-over';
      const base = ctx.createRadialGradient(width / 2, height / 2, 0, width / 2, height / 2, Math.max(width, height) * 0.7);
      base.addColorStop(0, '#1d0f17');
      base.addColorStop(1, '#070305');
      ctx.fillStyle = base;
      ctx.fillRect(0, 0, width, height);

      const reach = Math.max(width * 0.36, height * 0.8) * (1 + flareLevel * 0.9);
      const strength = 0.78 + flareLevel * 0.22;
      // A projector lamp is never perfectly steady.
      const flicker = reduce ? 1 : 0.975 + Math.random() * 0.025;

      ctx.globalCompositeOperation = 'screen';
      light(amber.x * width, amber.y * height, reach, AMBER, strength * flicker);
      light(teal.x * width, teal.y * height, reach * 1.04, TEAL, strength * 0.92 * flicker);

      if (flareLevel > 0.01) {
        ctx.fillStyle = `rgba(255,243,236,${flareLevel * 0.85})`;
        ctx.fillRect(0, 0, width, height);
      }

      // Vignette, so the picture falls off into the frame.
      ctx.globalCompositeOperation = 'source-over';
      const v = ctx.createRadialGradient(width / 2, height / 2, Math.min(width, height) * 0.3, width / 2, height / 2, Math.max(width, height) * 0.75);
      v.addColorStop(0, 'rgba(5,2,4,0)');
      v.addColorStop(1, 'rgba(5,2,4,0.55)');
      ctx.fillStyle = v;
      ctx.fillRect(0, 0, width, height);
    };

    const step = (dt: number) => {
      t += dt;
      const follow = 1 - Math.exp(-dt * 2.4);
      const drift = 1 - Math.exp(-dt * 1.2);

      const tx = 0.64 + 0.2 * Math.sin(t * 0.17) + 0.06 * Math.sin(t * 0.51);
      const ty = 0.5 + 0.26 * Math.sin(t * 0.23 + 1.3);
      teal.x += (tx - teal.x) * drift;
      teal.y += (ty - teal.y) * drift;

      const target = pointer ?? {
        x: 0.36 + 0.2 * Math.sin(t * 0.19 + 2.1) + 0.05 * Math.cos(t * 0.47),
        y: 0.5 + 0.28 * Math.cos(t * 0.15),
      };
      amber.x += (target.x - amber.x) * (pointer ? follow : drift);
      amber.y += (target.y - amber.y) * (pointer ? follow : drift);

      const flareTarget = flareRef.current ? 1 : 0;
      flareLevel += (flareTarget - flareLevel) * (1 - Math.exp(-dt * (flareTarget ? 5 : 2.5)));
    };

    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      if (now - last < FRAME_MS) return;
      const dt = last ? Math.min(0.1, (now - last) / 1000) : FRAME_MS / 1000;
      last = now;
      step(dt);
      draw();
      if (onLightsRef.current && now - lastReport > 66) {
        lastReport = now;
        onLightsRef.current(amber.x, teal.x);
      }
    };

    const start = () => {
      if (running || reduce || !visible || document.hidden) return;
      running = true;
      last = 0;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      running = false;
      cancelAnimationFrame(raf);
    };

    const onPointer = (e: PointerEvent) => {
      if (!interactive || e.pointerType !== 'mouse') return;
      const rect = canvas.getBoundingClientRect();
      const x = (e.clientX - rect.left) / rect.width;
      const y = (e.clientY - rect.top) / rect.height;
      // A generous margin, so the light reaches the edge of the frame
      // before letting go.
      pointer = x > -0.1 && x < 1.1 && y > -0.25 && y < 1.25 ? { x, y } : null;
    };
    const onLeave = () => {
      pointer = null;
    };
    const onVisibility = () => (document.hidden ? stop() : start());

    const ro = new ResizeObserver(resize);
    ro.observe(canvas);
    const io = new IntersectionObserver(([entry]) => {
      visible = entry.isIntersecting;
      if (visible) start();
      else stop();
    });
    io.observe(canvas);
    window.addEventListener('pointermove', onPointer, { passive: true });
    document.documentElement.addEventListener('pointerleave', onLeave);
    document.addEventListener('visibilitychange', onVisibility);

    resize();
    start();

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      window.removeEventListener('pointermove', onPointer);
      document.documentElement.removeEventListener('pointerleave', onLeave);
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [interactive]);

  return <canvas ref={canvasRef} className={className} aria-hidden="true" />;
}
