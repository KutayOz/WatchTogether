import { useEffect, useRef, type RefObject } from 'react';

/**
 * Close something when the pointer goes down outside `ref`, or on Escape.
 * `ref` should wrap the trigger as well as the panel, so the trigger's own
 * click toggles rather than closing and instantly reopening.
 */
export function useDismiss(
  ref: RefObject<HTMLElement | null>,
  onDismiss: () => void,
  enabled: boolean,
): void {
  const onDismissRef = useRef(onDismiss);
  useEffect(() => {
    onDismissRef.current = onDismiss;
  });

  useEffect(() => {
    if (!enabled) return;
    const onPointer = (e: PointerEvent) => {
      const el = ref.current;
      if (el && e.target instanceof Node && !el.contains(e.target)) onDismissRef.current();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onDismissRef.current();
      }
    };
    // Deferred a tick so the click that opened it does not also close it.
    const timer = window.setTimeout(() => {
      document.addEventListener('pointerdown', onPointer, true);
    }, 0);
    window.addEventListener('keydown', onKey, true);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener('pointerdown', onPointer, true);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [enabled, ref]);
}
