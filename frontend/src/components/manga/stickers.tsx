import { useRef, type CSSProperties, type ReactNode } from 'react';
import type { AccentColor } from './patterns';

/* ──────────────────────────────────────────────────────────── */
/* StickerGloss — laminated/sparkly highlight overlay          */
/* ──────────────────────────────────────────────────────────── */

interface StickerGlossProps {
  radius?: number | '50%';
  sparkles?: number;
  seed?: number;
}

export function StickerGloss({ radius = 14, sparkles = 4, seed = 0 }: StickerGlossProps) {
  const dots = Array.from({ length: sparkles }, (_, i) => {
    const r = ((i + 1) * 91 + seed * 37) % 100;
    const r2 = ((i + 1) * 173 + seed * 53) % 100;
    const size = 4 + ((i + seed) % 3) * 2;
    return { x: 6 + r * 0.84, y: 6 + r2 * 0.84, size, delay: i * 0.4 };
  });
  const br = radius === '50%' ? '50%' : `${radius}px`;
  return (
    <>
      <div className="stk-gloss-tl" style={{ borderRadius: br }} />
      <div className="stk-shine" style={{ borderRadius: br }} />
      <svg
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          pointerEvents: 'none',
          borderRadius: br,
          overflow: 'hidden',
        }}
        aria-hidden="true"
      >
        {dots.map((d, i) => (
          // Position via a nested <svg>: x/y accept % (the SVG `transform` attribute
          // does NOT), and it keeps positioning off the same `transform` channel the
          // twinkle animation drives — so the two no longer clobber each other.
          // overflow:visible because the star path is centred on the origin and
          // extends into negative coords.
          <svg key={i} x={`${d.x}%`} y={`${d.y}%`} overflow="visible">
            <g
              className="stk-sparkle"
              style={{ animationDelay: `${d.delay}s`, transformOrigin: 'center', transformBox: 'fill-box' }}
            >
              <path
                d={`M0 -${d.size} L ${d.size * 0.3} -${d.size * 0.3} L ${d.size} 0 L ${d.size * 0.3} ${d.size * 0.3} L 0 ${d.size} L -${d.size * 0.3} ${d.size * 0.3} L -${d.size} 0 L -${d.size * 0.3} -${d.size * 0.3} Z`}
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(255,255,255,0.5)"
                strokeWidth="0.5"
              />
            </g>
          </svg>
        ))}
      </svg>
    </>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Sticker — peel-card chrome (white backing + ink)            */
/* ──────────────────────────────────────────────────────────── */

interface StickerProps {
  children: ReactNode;
  rot?: number;
  w?: number | string;
  h?: number | string;
  style?: CSSProperties;
  onClick?: () => void;
  shape?: 'rounded' | 'circle' | 'sharp';
  seed?: number;
  glossy?: boolean;
}

export function Sticker({
  children,
  rot = 0,
  w,
  h,
  style,
  onClick,
  shape = 'rounded',
  seed = 0,
  glossy = true,
}: StickerProps) {
  const radius: number | '50%' = shape === 'circle' ? '50%' : shape === 'rounded' ? 14 : 4;
  const borderRadiusCss = radius === '50%' ? '50%' : `${radius}px`;
  return (
    <div
      onClick={onClick}
      style={{
        width: w,
        height: h,
        borderRadius: borderRadiusCss,
        position: 'relative',
        background: 'var(--cream)',
        border: '3.5px solid var(--ink)',
        boxShadow: '5px 5px 0 rgba(26,20,23,0.85), 0 0 0 5px var(--cream)',
        transform: `rotate(${rot}deg)`,
        transition: 'transform .18s cubic-bezier(.34,1.7,.64,1), box-shadow .18s',
        cursor: onClick ? 'pointer' : 'default',
        overflow: 'hidden',
        display: 'grid',
        placeItems: 'center',
        flexShrink: 0,
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'rotate(0) translate(-2px, -3px) scale(1.06)';
        e.currentTarget.style.boxShadow = '8px 9px 0 rgba(26,20,23,0.85), 0 0 0 5px var(--cream)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = `rotate(${rot}deg)`;
        e.currentTarget.style.boxShadow = '5px 5px 0 rgba(26,20,23,0.85), 0 0 0 5px var(--cream)';
      }}
    >
      <div style={{ position: 'relative', width: '100%', height: '100%', display: 'grid', placeItems: 'center', zIndex: 1 }}>
        {children}
      </div>
      {glossy && <StickerGloss radius={radius} sparkles={4} seed={seed} />}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* BurstSticker — explosive jagged shape                       */
/* ──────────────────────────────────────────────────────────── */

interface BurstStickerProps {
  children: ReactNode;
  bg?: string;
  w?: number;
  h?: number;
  rot?: number;
}

export function BurstSticker({
  children,
  bg = 'var(--orange)',
  w = 160,
  h = 110,
  rot = -4,
}: BurstStickerProps) {
  const uidRef = useRef<string>(Math.random().toString(36).slice(2, 9));
  const uid = uidRef.current;
  const cx = w / 2;
  const cy = h / 2;
  const points = 14;
  const rx = w / 2 - 8;
  const ry = h / 2 - 8;
  const path =
    Array.from({ length: points * 2 }, (_, i) => {
      const a = (i / (points * 2)) * Math.PI * 2;
      const isOuter = i % 2 === 0;
      const wobble = isOuter ? 1 + ((i * 0.41) % 1) * 0.14 : 0.7 + ((i * 0.27) % 1) * 0.1;
      const x = cx + Math.cos(a) * rx * wobble;
      const y = cy + Math.sin(a) * ry * wobble;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ') + ' Z';

  const sparkles = [
    { x: w * 0.32, y: h * 0.28, r: 3.2, d: 0 },
    { x: w * 0.62, y: h * 0.22, r: 2.2, d: 0.6 },
    { x: w * 0.74, y: h * 0.66, r: 2.6, d: 1.2 },
  ];

  return (
    <div
      style={{
        width: w,
        height: h,
        position: 'relative',
        transform: `rotate(${rot}deg)`,
        transition: 'transform .18s cubic-bezier(.34,1.7,.64,1)',
        cursor: 'default',
        flexShrink: 0,
      }}
    >
      <svg
        width={w}
        height={h}
        viewBox={`0 0 ${w} ${h}`}
        style={{
          position: 'absolute',
          inset: 0,
          filter: 'drop-shadow(4px 5px 0 rgba(26,20,23,0.85))',
          overflow: 'visible',
        }}
        aria-hidden="true"
      >
        <defs>
          <clipPath id={`burst-clip-${uid}`}>
            <path d={path} />
          </clipPath>
          <radialGradient id={`burst-shine-${uid}`} cx="0.28" cy="0.2" r="0.65">
            <stop offset="0%" stopColor="rgba(255,255,255,0.65)" />
            <stop offset="55%" stopColor="rgba(255,255,255,0)" />
          </radialGradient>
          <linearGradient id={`burst-sweep-${uid}`} x1="0" y1="0" x2="1" y2="0.3">
            <stop offset="38%" stopColor="rgba(255,255,255,0)" />
            <stop offset="50%" stopColor="rgba(255,255,255,0.5)" />
            <stop offset="62%" stopColor="rgba(255,255,255,0)" />
          </linearGradient>
        </defs>
        <path d={path} fill={bg} stroke="var(--ink)" strokeWidth="3.5" strokeLinejoin="round" />
        <g clipPath={`url(#burst-clip-${uid})`}>
          <rect x="0" y="0" width={w} height={h} fill={`url(#burst-shine-${uid})`} />
          <g style={{ animation: 'burstSweep 4.5s ease-in-out infinite', transformBox: 'fill-box' }}>
            <rect x={-w} y="0" width={w * 0.7} height={h} fill={`url(#burst-sweep-${uid})`} transform="skewX(-12)" />
          </g>
          {sparkles.map((s, i) => (
            <g
              key={i}
              className="stk-sparkle"
              style={{ animationDelay: `${s.d}s`, transformOrigin: `${s.x}px ${s.y}px`, transformBox: 'fill-box' }}
            >
              <path
                d={`M ${s.x} ${s.y - s.r * 2} L ${s.x + s.r * 0.5} ${s.y - s.r * 0.5} L ${s.x + s.r * 2} ${s.y} L ${s.x + s.r * 0.5} ${s.y + s.r * 0.5} L ${s.x} ${s.y + s.r * 2} L ${s.x - s.r * 0.5} ${s.y + s.r * 0.5} L ${s.x - s.r * 2} ${s.y} L ${s.x - s.r * 0.5} ${s.y - s.r * 0.5} Z`}
                fill="rgba(255,255,255,0.95)"
                stroke="rgba(255,255,255,0.5)"
                strokeWidth="0.5"
              />
            </g>
          ))}
        </g>
      </svg>
      <div
        style={{
          position: 'absolute',
          inset: 0,
          display: 'grid',
          placeItems: 'center',
          fontFamily: 'var(--font-sfx)',
          fontSize: typeof children === 'string' && children.length > 5 ? 24 : 32,
          letterSpacing: 2,
          color: 'var(--ink)',
          textShadow: '2px 2px 0 var(--cream)',
          padding: '0 8px',
          textAlign: 'center',
          lineHeight: 1,
          zIndex: 1,
        }}
      >
        {children}
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* TagSticker — tear-off ticket-style tab                      */
/* ──────────────────────────────────────────────────────────── */

interface TagStickerProps {
  children: ReactNode;
  color?: AccentColor;
  rot?: number;
}

export function TagSticker({ children, color = 'pink', rot = 0 }: TagStickerProps) {
  const bg =
    color === 'pink' ? 'var(--pink)' :
    color === 'orange' ? 'var(--orange)' :
    color === 'purple' ? 'var(--purple)' :
    color === 'ink' ? 'var(--ink)' :
    'var(--cream)';
  const fg = color === 'purple' || color === 'ink' ? 'var(--cream)' : 'var(--ink)';

  return (
    <div
      style={{
        fontFamily: 'var(--font-sfx)',
        fontSize: 18,
        letterSpacing: 1.5,
        padding: '10px 18px 8px 26px',
        background: bg,
        color: fg,
        border: '3px solid var(--ink)',
        borderRadius: '0 4px 4px 0',
        position: 'relative',
        boxShadow: '5px 5px 0 rgba(26,20,23,0.85)',
        transform: `rotate(${rot}deg)`,
        flexShrink: 0,
        transition: 'transform .18s',
        overflow: 'hidden',
        display: 'inline-block',
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'rotate(0) translate(-2px, -2px) scale(1.05)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = `rotate(${rot}deg)`;
      }}
    >
      <span
        style={{
          position: 'absolute',
          left: 8,
          top: '50%',
          transform: 'translateY(-50%)',
          width: 10,
          height: 10,
          borderRadius: '50%',
          background: 'var(--cream)',
          border: '2.5px solid var(--ink)',
          zIndex: 2,
        }}
      />
      <span style={{ position: 'relative', zIndex: 2 }}>{children}</span>
      <StickerGloss radius={4} sparkles={2} seed={typeof children === 'string' ? children.length : 3} />
    </div>
  );
}
