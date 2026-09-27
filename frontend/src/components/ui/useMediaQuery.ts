import { useSyncExternalStore } from 'react';

/**
 * Subscribe to a media query. useSyncExternalStore rather than state + effect
 * so the first render already has the right answer — a layout that renders the
 * desktop tree for one frame on a phone and then swaps is a visible flash.
 */
export function useMediaQuery(query: string): boolean {
  return useSyncExternalStore(
    (onChange) => {
      const mql = window.matchMedia(query);
      mql.addEventListener('change', onChange);
      return () => mql.removeEventListener('change', onChange);
    },
    () => window.matchMedia(query).matches,
    () => false,
  );
}

export const PHONE = '(max-width: 560px)';
export const COMPACT = '(max-width: 1023px)';
export const REDUCED_MOTION = '(prefers-reduced-motion: reduce)';
