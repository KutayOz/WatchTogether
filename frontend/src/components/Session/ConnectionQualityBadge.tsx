import type { QualityLevel } from '../../types';
// The producer's type, not a copy of it. This interface used to be redeclared
// here field-for-field, which is only ever right until one side changes.
import type { QualityMetrics } from '../../hooks/useQualityMonitor';

interface ConnectionQualityBadgeProps {
  quality: QualityLevel | null;
  metrics: QualityMetrics | null;
}

/**
 * Signal-bar indicator for the call, fed by useQualityMonitor. Hovering shows
 * the numbers underneath (RTT, loss, jitter, fps) so a power user can see
 * *why* a bar dropped.
 *
 * The bar count is deliberately discrete (1–4) rather than continuous: it
 * mirrors how OS-level wifi indicators behave and scans at a glance. The
 * tooltip carries the precise numbers for the people who want them.
 */

const QUALITY_CONFIG: Record<QualityLevel, { bars: 1 | 2 | 3 | 4; colour: string; label: string }> = {
  excellent: { bars: 4, colour: 'var(--teal)', label: 'excellent' },
  good: { bars: 3, colour: 'var(--teal)', label: 'good' },
  fair: { bars: 2, colour: 'var(--amber)', label: 'fair' },
  poor: { bars: 1, colour: 'var(--exit)', label: 'poor' },
  critical: { bars: 1, colour: 'var(--exit)', label: 'critical' },
};

function formatTooltip(metrics: QualityMetrics | null): string {
  if (!metrics) return 'Measuring the connection…';
  const total = metrics.packetsReceived + metrics.packetsLost;
  const lossPct = total > 0 ? (metrics.packetsLost / total) * 100 : 0;
  // Freezes replace the old frames-dropped line: dropped frames were a running
  // total that only ever grew, so once it passed the threshold the badge said
  // "drops" for the rest of the call. Freeze seconds are per-interval, so this
  // reads as what is happening now.
  const parts = [
    `RTT ${Math.round(metrics.rttMs)} ms`,
    `loss ${lossPct.toFixed(1)}%`,
    `jitter ${Math.round(metrics.jitterMs)} ms`,
  ];
  if (metrics.fps > 0) parts.push(`${Math.round(metrics.fps)} fps`);
  if (metrics.freezeSeconds > 0.1) parts.push(`${metrics.freezeSeconds.toFixed(1)} s frozen`);
  return parts.join(', ');
}

export function ConnectionQualityBadge({ quality, metrics }: ConnectionQualityBadgeProps) {
  // Until the first stats poll completes, a neutral "measuring" state keeps
  // the slot from jumping in and out as the call starts.
  if (!quality) {
    return (
      <span className="qbars" title="Measuring the connection…" aria-label="Measuring connection">
        <Bars filled={0} />
        <span>Measuring</span>
      </span>
    );
  }

  const cfg = QUALITY_CONFIG[quality];
  return (
    <span
      className="qbars"
      data-level={quality}
      style={{ color: cfg.colour }}
      title={formatTooltip(metrics)}
      aria-label={`Connection quality: ${cfg.label}. ${formatTooltip(metrics)}`}
    >
      <Bars filled={cfg.bars} />
      <span style={{ textTransform: 'capitalize' }}>{cfg.label}</span>
    </span>
  );
}

function Bars({ filled }: { filled: number }) {
  return (
    <span className="qbars__bars" aria-hidden="true">
      {[5, 8, 11, 14].map((h, i) => (
        <span key={h} style={{ height: h }} data-on={i < filled ? '' : undefined} />
      ))}
    </span>
  );
}
