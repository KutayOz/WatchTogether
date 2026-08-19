import { useCallback, useEffect, useRef } from 'react';
import type { DiagnosticsSnapshot } from './diagnosticsReport';

/**
 * Keeps the last few minutes of diagnostics so a report can describe what
 * HAPPENED, not only what is happening.
 *
 * The panel this replaces showed one three-second sample and then forgot it,
 * which is the wrong shape for every question worth asking: did the picture
 * collapse at once or walk down, did the freezes start before or after the
 * budget moved, was the path already relayed when the share began. All of those
 * are questions about a sequence.
 *
 * Its own interval rather than riding someone else's poll, so it keeps
 * recording while nobody is sharing — the seconds before a share starts are
 * often the ones that explain it — and it writes to a ref, so six minutes of
 * samples cost zero re-renders.
 */

/** Same three seconds as every other poller here, so the rows line up. */
const POLL_INTERVAL_MS = 3000;

/** Six minutes. Bounded because a session runs for hours. */
export const RECORDER_CAPACITY = 120;

export interface DiagnosticsRecorder {
  /** Everything held, oldest first. */
  samples: () => DiagnosticsSnapshot[];
  /** Force a sample now, so a report is never empty on the first press. */
  capture: () => void;
}

/**
 * @param active Record while true.
 * @param read   Called on each tick for the current values. Rebuilt every
 *   render by the caller and held in a ref, the same trick `useSenderHealth`
 *   uses for its ceiling: the poller must see fresh state without the interval
 *   being torn down and rebuilt whenever any of it changes.
 */
export function useDiagnosticsRecorder(
  active: boolean,
  read: () => Omit<DiagnosticsSnapshot, 'atMs'>,
): DiagnosticsRecorder {
  const readRef = useRef(read);
  useEffect(() => {
    readRef.current = read;
  });

  const samplesRef = useRef<DiagnosticsSnapshot[]>([]);
  const startedAtRef = useRef(0);

  const capture = useCallback(() => {
    if (startedAtRef.current === 0) startedAtRef.current = Date.now();
    const held = samplesRef.current;
    held.push({ ...readRef.current(), atMs: Date.now() - startedAtRef.current });
    if (held.length > RECORDER_CAPACITY) held.splice(0, held.length - RECORDER_CAPACITY);
  }, []);

  useEffect(() => {
    if (!active) return;

    startedAtRef.current = Date.now();
    capture();
    const id = setInterval(capture, POLL_INTERVAL_MS);

    return () => {
      clearInterval(id);
      // Samples belong to one call. Carrying them into the next would put two
      // different connections in one table with no seam to see it by.
      samplesRef.current = [];
      startedAtRef.current = 0;
    };
  }, [active, capture]);

  const samples = useCallback(() => [...samplesRef.current], []);

  return { samples, capture };
}
