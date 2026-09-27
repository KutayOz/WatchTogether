import type { QualityLevel } from '../../types';

interface QualityIndicatorProps {
  level: QualityLevel | null;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const LEVEL_CONFIG: Record<QualityLevel, { bars: number; colour: string; label: string }> = {
  excellent: { bars: 4, colour: 'var(--teal)', label: 'Great' },
  good: { bars: 3, colour: 'var(--teal)', label: 'Good' },
  fair: { bars: 2, colour: 'var(--amber)', label: 'OK' },
  poor: { bars: 1, colour: 'var(--exit)', label: 'Spotty' },
  critical: { bars: 0, colour: 'var(--exit)', label: 'Bad' },
};

/**
 * How the picture is arriving, as signal bars on a glass chip — the one
 * shown over a shared screen. Colour follows the bars: teal while it is
 * fine, amber when it slips, red when it is breaking up.
 */
export function QualityIndicator({ level, showLabel = false }: QualityIndicatorProps) {
  if (!level) return null;
  const config = LEVEL_CONFIG[level];
  return (
    <span
      className="chip chip--glass qbars"
      data-level={level}
      style={{ ['--q' as string]: config.colour, color: config.colour }}
      aria-label={`Picture quality: ${config.label}`}
      title={`Picture quality: ${config.label}`}
    >
      <span className="qbars__bars" aria-hidden="true">
        {[5, 8, 11, 14].map((h, i) => (
          <span key={h} style={{ height: h }} data-on={i < config.bars ? '' : undefined} />
        ))}
      </span>
      {showLabel && <span>{config.label}</span>}
    </span>
  );
}
