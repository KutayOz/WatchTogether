import type { CSSProperties, ReactNode } from 'react';

/**
 * ScreentoneDefs — SVG <defs> that every screen references via fill="url(#tone-…)".
 * Mount this ONCE at the App root so all child SVGs can reference these patterns.
 */
export function ScreentoneDefs() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <defs>
        {/* PINK DOTS — standard shading */}
        <pattern id="tone-pink" width="10" height="10" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">
          <circle cx="3" cy="3" r="1.8" fill="#FF4FA3" opacity="0.85" />
        </pattern>
        <pattern id="tone-pink-sparse" width="14" height="14" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">
          <circle cx="4" cy="4" r="1.5" fill="#FF4FA3" opacity="0.75" />
        </pattern>
        <pattern id="tone-pink-tight" width="7" height="7" patternUnits="userSpaceOnUse" patternTransform="rotate(15)">
          <circle cx="2" cy="2" r="1.6" fill="#FF4FA3" opacity="0.9" />
        </pattern>

        {/* PURPLE DOTS — intensity */}
        <pattern id="tone-purple" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(-15)">
          <circle cx="3" cy="3" r="1.8" fill="#7B3FE4" opacity="0.85" />
        </pattern>
        <pattern id="tone-purple-tight" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(-15)">
          <circle cx="2" cy="2" r="1.5" fill="#7B3FE4" opacity="0.9" />
        </pattern>

        {/* ORANGE DOTS — alarm */}
        <pattern id="tone-orange" width="9" height="9" patternUnits="userSpaceOnUse" patternTransform="rotate(20)">
          <circle cx="3" cy="3" r="1.8" fill="#FF7A29" opacity="0.9" />
        </pattern>

        {/* PARALLEL LINES — motion */}
        <pattern id="tone-lines" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#1A1417" strokeWidth="1.2" opacity="0.8" />
        </pattern>
        <pattern id="tone-lines-pink" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(35)">
          <line x1="0" y1="0" x2="0" y2="6" stroke="#FF4FA3" strokeWidth="1.4" opacity="0.85" />
        </pattern>

        {/* CROSSHATCH */}
        <pattern id="tone-cross" width="8" height="8" patternUnits="userSpaceOnUse" patternTransform="rotate(20)">
          <line x1="0" y1="0" x2="0" y2="8" stroke="#1A1417" strokeWidth="0.8" opacity="0.65" />
          <line x1="0" y1="0" x2="8" y2="0" stroke="#1A1417" strokeWidth="0.8" opacity="0.65" />
        </pattern>

        {/* GRADIENT DOTS (pink→purple, "magic") */}
        <linearGradient id="magicGrad" x1="0" y1="0" x2="1" y2="1">
          <stop offset="0%" stopColor="#FF4FA3" />
          <stop offset="100%" stopColor="#7B3FE4" />
        </linearGradient>
        <pattern id="tone-magic" width="10" height="10" patternUnits="userSpaceOnUse">
          <circle cx="3" cy="3" r="2" fill="url(#magicGrad)" />
        </pattern>
      </defs>
    </svg>
  );
}

export type ToneKind =
  | 'pink' | 'pink-sparse' | 'pink-tight'
  | 'purple' | 'purple-tight'
  | 'orange' | 'lines' | 'lines-pink' | 'cross' | 'magic';

export type AccentColor = 'pink' | 'purple' | 'orange' | 'cream' | 'ink';

export type DoodleKind =
  | 'star' | 'heart' | 'squiggle' | 'tv' | 'popcorn' | 'arrow' | 'sparkle'
  | 'circle-mark' | 'check' | 'x' | 'z' | 'key' | 'envelope' | 'airplane';

interface DoodleProps {
  kind: DoodleKind;
  size?: number;
  color?: string;
  strokeWidth?: number;
  style?: CSSProperties;
}

export function Doodle({ kind, size = 64, color = 'var(--ink)', strokeWidth = 3, style }: DoodleProps) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 64 64',
    fill: 'none',
    stroke: color,
    strokeWidth,
    strokeLinecap: 'round' as const,
    strokeLinejoin: 'round' as const,
    style,
  };
  switch (kind) {
    case 'star':
      return (
        <svg {...common}>
          <path d="M32 8 L37 26 L56 26 L41 37 L46 56 L32 45 L18 56 L23 37 L8 26 L27 26 Z" />
        </svg>
      );
    case 'heart':
      return (
        <svg {...common}>
          <path d="M32 54 C 12 40, 8 24, 18 16 C 26 10, 32 18, 32 22 C 32 18, 38 10, 46 16 C 56 24, 52 40, 32 54 Z" />
        </svg>
      );
    case 'squiggle':
      return (
        <svg {...common} viewBox="0 0 80 24">
          <path d="M4 12 C 12 2, 20 22, 28 12 S 44 2, 52 12 S 68 22, 76 12" />
        </svg>
      );
    case 'tv':
      return (
        <svg {...common}>
          <rect x="8" y="16" width="48" height="34" rx="3" />
          <path d="M20 8 L30 16 M44 8 L34 16" />
          <line x1="14" y1="50" x2="14" y2="56" />
          <line x1="50" y1="50" x2="50" y2="56" />
        </svg>
      );
    case 'popcorn':
      return (
        <svg {...common}>
          <path d="M14 24 L20 56 L44 56 L50 24 Z" />
          <path d="M14 24 L50 24" />
          <circle cx="20" cy="20" r="6" />
          <circle cx="30" cy="14" r="7" />
          <circle cx="42" cy="18" r="6" />
          <circle cx="50" cy="22" r="5" />
          <line x1="26" y1="32" x2="28" y2="50" />
          <line x1="36" y1="32" x2="34" y2="50" />
        </svg>
      );
    case 'arrow':
      return (
        <svg {...common} viewBox="0 0 80 40">
          <path d="M6 30 C 20 6, 50 6, 70 22" />
          <path d="M62 14 L72 22 L62 26" />
        </svg>
      );
    case 'sparkle':
      return (
        <svg {...common} viewBox="0 0 24 24">
          <path
            d="M12 2 L13.5 10.5 L22 12 L13.5 13.5 L12 22 L10.5 13.5 L2 12 L10.5 10.5 Z"
            fill={color}
            stroke="none"
          />
        </svg>
      );
    case 'circle-mark':
      return (
        <svg {...common} viewBox="0 0 100 60">
          <ellipse cx="50" cy="30" rx="44" ry="22" />
        </svg>
      );
    case 'check':
      return (
        <svg {...common}>
          <path d="M12 32 L26 46 L54 18" />
        </svg>
      );
    case 'x':
      return (
        <svg {...common}>
          <path d="M14 14 L50 50 M50 14 L14 50" />
        </svg>
      );
    case 'z':
      return (
        <svg {...common} viewBox="0 0 40 40">
          <path d="M10 10 L30 10 L10 30 L30 30" />
        </svg>
      );
    case 'key':
      return (
        <svg {...common}>
          <circle cx="20" cy="32" r="10" />
          <path d="M28 32 L56 32 M48 32 L48 40 M54 32 L54 38" />
        </svg>
      );
    case 'envelope':
      return (
        <svg {...common}>
          <rect x="6" y="14" width="52" height="36" rx="2" />
          <path d="M6 16 L32 36 L58 16" />
        </svg>
      );
    case 'airplane':
      return (
        <svg {...common} viewBox="0 0 48 48">
          <path d="M4 28 L44 8 L36 44 L24 30 L10 36 Z" />
          <path d="M24 30 L36 16" />
        </svg>
      );
    default:
      return null;
  }
}

interface SFXProps {
  children: ReactNode;
  size?: number;
  color?: string;
  tone?: 'pink' | 'orange' | 'purple';
  angle?: number;
  style?: CSSProperties;
  stroke?: number;
}

export function SFX({
  children,
  size = 56,
  color = 'var(--ink)',
  tone = 'pink',
  angle = -8,
  style,
  stroke = 1,
}: SFXProps) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-sfx)',
        fontSize: size,
        lineHeight: 1,
        letterSpacing: '2px',
        color,
        WebkitTextStroke: `${stroke}px var(--ink)`,
        display: 'inline-block',
        transform: `rotate(${angle}deg)`,
        textShadow: `4px 4px 0 var(--${tone})`,
        ...style,
      }}
    >
      {children}
    </span>
  );
}

interface SpeedLinesProps {
  count?: number;
  radius?: number;
  color?: string;
  style?: CSSProperties;
}

export function SpeedLines({ count = 12, radius = 140, color = 'var(--ink)', style }: SpeedLinesProps) {
  const lines = Array.from({ length: count }, (_, i) => {
    const a = (i / count) * Math.PI * 2;
    const r1 = radius * 0.55;
    const r2 = radius * (0.85 + (i % 3) * 0.05);
    return (
      <line
        key={i}
        x1={Math.cos(a) * r1}
        y1={Math.sin(a) * r1}
        x2={Math.cos(a) * r2}
        y2={Math.sin(a) * r2}
        stroke={color}
        strokeWidth={3 + (i % 2)}
        strokeLinecap="round"
      />
    );
  });
  return (
    <svg
      width={radius * 2}
      height={radius * 2}
      viewBox={`${-radius} ${-radius} ${radius * 2} ${radius * 2}`}
      style={{ position: 'absolute', pointerEvents: 'none', ...style }}
      aria-hidden="true"
    >
      {lines}
    </svg>
  );
}

interface SpikeBurstProps {
  width?: number;
  height?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
  points?: number;
  children?: ReactNode;
  style?: CSSProperties;
}

export function SpikeBurst({
  width = 220,
  height = 140,
  fill = 'var(--orange)',
  stroke = 'var(--ink)',
  strokeWidth = 4,
  points = 18,
  children,
  style,
}: SpikeBurstProps) {
  const cx = width / 2;
  const cy = height / 2;
  const rx = width / 2 - strokeWidth - 4;
  const ry = height / 2 - strokeWidth - 4;
  const path =
    Array.from({ length: points * 2 }, (_, i) => {
      const angle = (i / (points * 2)) * Math.PI * 2;
      const isOuter = i % 2 === 0;
      const wobble = isOuter ? 1 + ((i * 0.37) % 1) * 0.15 : 0.72 + ((i * 0.21) % 1) * 0.12;
      const x = cx + Math.cos(angle) * rx * wobble;
      const y = cy + Math.sin(angle) * ry * wobble;
      return `${i === 0 ? 'M' : 'L'} ${x.toFixed(1)} ${y.toFixed(1)}`;
    }).join(' ') + ' Z';

  return (
    <div style={{ position: 'relative', width, height, display: 'inline-block', ...style }}>
      <svg
        width={width}
        height={height}
        viewBox={`0 0 ${width} ${height}`}
        style={{ position: 'absolute', inset: 0 }}
        aria-hidden="true"
      >
        <path d={path} fill={fill} stroke={stroke} strokeWidth={strokeWidth} strokeLinejoin="round" />
      </svg>
      <div
        style={{
          position: 'relative',
          zIndex: 1,
          width: '100%',
          height: '100%',
          display: 'grid',
          placeItems: 'center',
          padding: 18,
          textAlign: 'center',
        }}
      >
        {children}
      </div>
    </div>
  );
}

interface PaperGrainProps {
  opacity?: number;
}

export function PaperGrain({ opacity = 0.2 }: PaperGrainProps) {
  return (
    <svg
      aria-hidden="true"
      style={{
        position: 'absolute',
        inset: 0,
        width: '100%',
        height: '100%',
        pointerEvents: 'none',
        opacity,
        mixBlendMode: 'multiply',
      }}
    >
      <filter id="paper-noise">
        <feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves={2} seed={3} />
        <feColorMatrix values="0 0 0 0 0.1  0 0 0 0 0.08  0 0 0 0 0.09  0 0 0 0.5 0" />
      </filter>
      <rect width="100%" height="100%" filter="url(#paper-noise)" />
    </svg>
  );
}
