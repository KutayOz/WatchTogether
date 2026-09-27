import { m } from 'motion/react';
import { Link } from 'react-router-dom';
import { spring } from './motion';

interface LightsProps {
  /**
   * Whether both people are here. Apart, the second light is an empty outline
   * — a seat saved — and when they arrive it fills and slides over yours.
   */
  together?: boolean;
  size?: number;
  className?: string;
}

/**
 * The mark: two lights, amber for you and teal for them. Blended with
 * `screen`, the overlap comes out as the warm white of a lit screen.
 */
export function Lights({ together = true, size = 34, className }: LightsProps) {
  const height = (size * 24) / 40;
  return (
    <svg
      className={['lights', className].filter(Boolean).join(' ')}
      width={size}
      height={height}
      viewBox="0 0 40 24"
      aria-hidden="true"
      focusable="false"
    >
      <m.circle
        cy="12"
        r="9.5"
        fill="var(--amber)"
        initial={{ cx: 10 }}
        animate={{ cx: together ? 15 : 10 }}
        transition={{ ...spring.soft, delay: 0.15 }}
      />
      {/* Colours in comma rgba: the animation engine interpolates those, and
          the first frame is already the right one rather than an unset fill
          that renders black. */}
      <m.circle
        cy="12"
        r="9.5"
        initial={{ cx: 30, opacity: 0.9, fill: 'rgba(90,212,230,0)', stroke: 'rgba(90,212,230,0.75)' }}
        animate={{
          cx: together ? 25 : 30,
          opacity: 1,
          fill: together ? 'rgba(90,212,230,1)' : 'rgba(90,212,230,0)',
          stroke: together ? 'rgba(90,212,230,0)' : 'rgba(90,212,230,0.75)',
        }}
        strokeWidth={1.6}
        strokeDasharray={together ? undefined : '3 3'}
        transition={{ ...spring.soft, delay: 0.15 }}
      />
    </svg>
  );
}

/** The mark plus the name, linking home. */
export function Brand({ to = '/', together = true }: { to?: string; together?: boolean }) {
  return (
    <Link to={to} className="brand" aria-label="WatchTogether home">
      <Lights together={together} />
      <span className="brand__word">WatchTogether</span>
    </Link>
  );
}
