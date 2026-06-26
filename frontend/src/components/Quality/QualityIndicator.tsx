import type { QualityLevel } from '../../types';

interface QualityIndicatorProps {
  level: QualityLevel | null;
  showLabel?: boolean;
  size?: 'sm' | 'md' | 'lg';
}

const LEVEL_CONFIG: Record<QualityLevel, { bars: number; bg: string; pulse: boolean; label: string }> = {
  excellent: { bars: 4, bg: 'var(--pink)',   pulse: false, label: 'great' },
  good:      { bars: 3, bg: 'var(--pink)',   pulse: false, label: 'good' },
  fair:      { bars: 2, bg: 'var(--purple)', pulse: false, label: 'ok' },
  poor:      { bars: 1, bg: 'var(--orange)', pulse: true,  label: 'spotty' },
  critical:  { bars: 0, bg: 'var(--orange)', pulse: true,  label: 'bad' },
};

const SIZE_HEIGHT = { sm: 14, md: 18, lg: 22 };
const SIZE_BAR_WIDTH = { sm: 3, md: 4, lg: 5 };
const SIZE_FONT = { sm: 12, md: 14, lg: 16 };

/**
 * QualityIndicator — small sticker badge showing connection quality bars.
 */
export function QualityIndicator({ level, showLabel = false, size = 'md' }: QualityIndicatorProps) {
  if (!level) return null;

  const config = LEVEL_CONFIG[level];
  const h = SIZE_HEIGHT[size];
  const bw = SIZE_BAR_WIDTH[size];

  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        padding: '4px 10px',
        background: config.bg,
        color: 'var(--ink)',
        border: '2.5px solid var(--ink)',
        borderRadius: 10,
        boxShadow: '3px 3px 0 var(--ink)',
        fontFamily: 'var(--font-sfx)',
        fontSize: SIZE_FONT[size],
        letterSpacing: 1,
        transform: 'rotate(-2deg)',
      }}
    >
      {config.pulse && (
        <span
          style={{
            width: 8,
            height: 8,
            background: 'var(--ink)',
            borderRadius: 999,
            animation: 'speakPulse 1.2s ease-in-out infinite',
          }}
          aria-hidden="true"
        />
      )}
      {/* Bars */}
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 2, height: h }}>
        {[0.3, 0.55, 0.8, 1].map((relative, i) => {
          const isActive = i < config.bars;
          return (
            <div
              key={i}
              style={{
                width: bw,
                height: `${relative * 100}%`,
                background: isActive ? 'var(--ink)' : 'rgba(26,20,23,0.25)',
                borderRadius: 1,
              }}
            />
          );
        })}
      </div>
      {showLabel && <span>{config.label.toUpperCase()}</span>}
    </div>
  );
}
