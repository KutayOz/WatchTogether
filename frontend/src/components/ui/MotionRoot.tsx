import type { ReactNode } from 'react';
import { LazyMotion, MotionConfig, domMax } from 'motion/react';

/**
 * Motion for the whole tree.
 *
 * Components use the lightweight `m.*` elements with the features handed in
 * here. `strict` makes a stray `motion.div` throw — one full-fat component is
 * how the whole library quietly ends up duplicated into a route chunk.
 *
 * `reducedMotion="user"` turns every transform and layout animation into an
 * instant change for anyone who asked their OS for less movement — opacity
 * still fades, so things do not pop.
 */
export function MotionRoot({ children }: { children: ReactNode }) {
  return (
    <LazyMotion features={domMax} strict>
      <MotionConfig reducedMotion="user">{children}</MotionConfig>
    </LazyMotion>
  );
}
