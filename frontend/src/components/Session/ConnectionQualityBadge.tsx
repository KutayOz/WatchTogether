import type { QualityLevel } from '../../types';

interface QualityMetrics {
  packetsLost: number;
  packetsReceived: number;
  jitterMs: number;
  rttMs: number;
  fps: number;
  framesDropped: number;
}

interface ConnectionQualityBadgeProps {
  quality: QualityLevel | null;
  metrics: QualityMetrics | null;
}

/**
 * Wifi-bar style header indicator showing the current call-quality level
 * sourced from useQualityMonitor. Hovering reveals the underlying metrics
 * (RTT, packet loss, jitter, fps) so a power user can see *why* the bar
 * dropped — useful when debugging "why is it choppy" with the peer.
 *
 * The bars-filled count is deliberately discrete (1, 2, 3, 4) rather than
 * continuous: it mirrors how OS-level wifi indicators behave and is much
 * easier to scan at a glance than a percentage. The tooltip carries the
 * precise numbers for the people who actually want them.
 */

const QUALITY_CONFIG: Record<
  QualityLevel,
  { bars: 1 | 2 | 3 | 4; color: string; label: string }
> = {
  excellent: { bars: 4, color: 'var(--purple)',      label: 'excellent' },
  good:      { bars: 3, color: 'var(--pink)',        label: 'good'      },
  fair:      { bars: 2, color: 'var(--orange)',      label: 'fair'      },
  poor:      { bars: 1, color: 'var(--orange-deep, var(--orange))', label: 'poor'  },
  critical:  { bars: 1, color: 'var(--orange-deep, var(--orange))', label: 'critical' },
};

function formatTooltip(metrics: QualityMetrics | null): string {
  if (!metrics) return 'measuring connection…';
  const total = metrics.packetsReceived + metrics.packetsLost;
  const lossPct = total > 0 ? (metrics.packetsLost / total) * 100 : 0;
  // Compact "RTT · loss · jitter" — only include fps if it's actually being
  // measured (>0). framesDropped only included if non-trivial.
  const parts = [
    `RTT ${Math.round(metrics.rttMs)}ms`,
    `loss ${lossPct.toFixed(1)}%`,
    `jitter ${Math.round(metrics.jitterMs)}ms`,
  ];
  if (metrics.fps > 0) parts.push(`${Math.round(metrics.fps)} fps`);
  if (metrics.framesDropped > 5) parts.push(`${metrics.framesDropped} drops`);
  return parts.join(' · ');
}

export function ConnectionQualityBadge({ quality, metrics }: ConnectionQualityBadgeProps) {
  // Until the first stats poll completes, show a neutral "measuring" pill
  // so the badge slot doesn't jump in and out as the call starts.
  if (!quality) {
    return (
      <span
        title="measuring connection…"
        aria-label="measuring connection"
        className="hand"
        style={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 6,
          fontSize: 14,
          color: 'rgba(26,20,23,0.45)',
          transform: 'rotate(-1deg)',
        }}
      >
        <QualityBars filled={0} color="rgba(26,20,23,0.4)" />
        <span>measuring…</span>
      </span>
    );
  }

  const cfg = QUALITY_CONFIG[quality];
  const isCritical = quality === 'critical';

  return (
    <span
      title={formatTooltip(metrics)}
      aria-label={`connection quality: ${cfg.label}. ${formatTooltip(metrics)}`}
      className="hand"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        fontSize: 14,
        color: cfg.color,
        transform: 'rotate(-1deg)',
        // Subtle pulse on critical — alerts without being aggressive.
        animation: isCritical ? 'pulse-critical 1.4s ease-in-out infinite' : undefined,
      }}
    >
      <QualityBars filled={cfg.bars} color={cfg.color} />
      <span>{cfg.label}</span>
      {/* Keyframes scoped inline so we don't pollute the global stylesheet
          for a single critical-state animation. */}
      {isCritical && (
        <style>{`
          @keyframes pulse-critical {
            0%, 100% { opacity: 1; }
            50%      { opacity: 0.55; }
          }
        `}</style>
      )}
    </span>
  );
}

/* ────────────────────────────────────────────────────────────── */
/* QualityBars — 4 staggered bars, growing left→right. Empty bars  */
/* render as faint ghosts so the badge keeps its full width even   */
/* when only one bar is lit (no shifting layout as quality changes).*/
/* ────────────────────────────────────────────────────────────── */

function QualityBars({ filled, color }: { filled: number; color: string }) {
  const total = 4;
  // Heights grow linearly so the silhouette reads as "wifi strength."
  const heights = [6, 9, 12, 15];
  return (
    <span
      aria-hidden="true"
      style={{ display: 'inline-flex', alignItems: 'flex-end', gap: 2, height: 16 }}
    >
      {Array.from({ length: total }).map((_, i) => {
        const isOn = i < filled;
        return (
          <span
            key={i}
            style={{
              width: 4,
              height: heights[i],
              background: isOn ? color : 'rgba(26,20,23,0.15)',
              border: '1px solid var(--ink)',
              transition: 'background 200ms ease',
            }}
          />
        );
      })}
    </span>
  );
}
