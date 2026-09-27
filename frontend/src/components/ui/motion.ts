import type { Transition, Variants } from 'motion/react';

/**
 * Motion vocabulary, kept small on purpose so the app moves in one voice.
 *
 * Two kinds of movement and nothing else:
 *   - springs, for anything answering a person (opening, pressing, dragging)
 *   - the focus pull, for things arriving on screen: they come in slightly
 *     soft and slightly large and settle sharp, the way a projector finds focus
 */

export const spring = {
  /** Controls, toggles, small things snapping into place. */
  snappy: { type: 'spring', stiffness: 560, damping: 36, mass: 0.7 },
  /** Panels, sheets, anything with some size to it. */
  soft: { type: 'spring', stiffness: 260, damping: 30, mass: 0.9 },
  /** One overshoot. For moments worth a small flourish. */
  lively: { type: 'spring', stiffness: 420, damping: 20, mass: 0.8 },
} satisfies Record<string, Transition>;

export const ease = {
  out: [0.22, 1, 0.36, 1],
  inOut: [0.65, 0, 0.35, 1],
} as const;

/** Arrive like a projected image coming into focus. */
export const focusPull: Variants = {
  hidden: { opacity: 0, scale: 1.02, filter: 'blur(10px)' },
  shown: {
    opacity: 1,
    scale: 1,
    filter: 'blur(0px)',
    transition: { duration: 0.75, ease: ease.out },
  },
};

/** The workhorse entrance for content inside a page. */
export const rise: Variants = {
  hidden: { opacity: 0, y: 16 },
  shown: { opacity: 1, y: 0, transition: { duration: 0.6, ease: ease.out } },
};

export const fade: Variants = {
  hidden: { opacity: 0 },
  shown: { opacity: 1, transition: { duration: 0.4, ease: ease.out } },
};

/** Parent that lets its children arrive one after another. */
export function cascade(stagger = 0.07, delay = 0): Variants {
  return {
    hidden: {},
    shown: { transition: { staggerChildren: stagger, delayChildren: delay } },
  };
}
