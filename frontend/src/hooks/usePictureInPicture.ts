import { logger } from '../services/logger';
import { useCallback, useEffect, useState, type RefObject } from 'react';

interface UsePictureInPictureOptions {
  /** The video element we want to pop out. */
  videoRef: RefObject<HTMLVideoElement | null>;
  /**
   * When true, auto-enter PiP if the session tab becomes hidden, and
   * auto-exit when it returns. This is the "magic" UX — user switches
   * to another tab and the peer follows them.
   */
  autoOnHide?: boolean;
}

interface UsePictureInPictureReturn {
  /** True if PiP is supported in this browser at all. */
  isSupported: boolean;
  /** True if the bound video is currently in a PiP window. */
  isActive: boolean;
  /** Toggle on/off. No-op if unsupported. */
  toggle: () => Promise<void>;
}

/**
 * Native `<video>` Picture-in-Picture wrapper. Document PiP (Chrome 116+)
 * would let us pop out arbitrary HTML, but native video PiP is supported
 * in Chrome/Edge/Safari going back years and meets the actual user need
 * (keep seeing the peer while doing something else). Firefox has it
 * gated behind a pref; we feature-detect and just hide the toggle there.
 *
 * Auto-on-hide semantics: when `autoOnHide` is true, we enter PiP the
 * moment the tab transitions to hidden and exit when it becomes visible
 * again. The visibility API delivers exactly one event per transition,
 * so we don't burn CPU on idle scrolling.
 */
export function usePictureInPicture({
  videoRef,
  autoOnHide = false,
}: UsePictureInPictureOptions): UsePictureInPictureReturn {
  // Feature detection: pictureInPictureEnabled is the documented signal.
  // `document.pictureInPictureEnabled` can be false even when the API
  // exists (Permissions-Policy blocks it on iframe contexts) — that's
  // exactly the behavior we want, so check both.
  const isSupported =
    typeof document !== 'undefined' &&
    'pictureInPictureEnabled' in document &&
    document.pictureInPictureEnabled === true;

  const [isActive, setIsActive] = useState(false);

  // Track PiP enter/leave on the document — the events come from the
  // global pictureInPictureElement, not the video element directly, so
  // we listen at document level.
  useEffect(() => {
    if (!isSupported) return;
    const onEnter = () => {
      // Only flip our state if the active PiP element is OUR video.
      // (Otherwise some other PiP on the page would set us active.)
      if (document.pictureInPictureElement === videoRef.current) {
        setIsActive(true);
      }
    };
    const onLeave = () => setIsActive(false);
    const video = videoRef.current;
    video?.addEventListener('enterpictureinpicture', onEnter);
    video?.addEventListener('leavepictureinpicture', onLeave);
    return () => {
      video?.removeEventListener('enterpictureinpicture', onEnter);
      video?.removeEventListener('leavepictureinpicture', onLeave);
    };
  }, [videoRef, isSupported]);

  const toggle = useCallback(async () => {
    if (!isSupported) return;
    const video = videoRef.current;
    if (!video) return;
    try {
      if (document.pictureInPictureElement === video) {
        await document.exitPictureInPicture();
      } else {
        await video.requestPictureInPicture();
      }
    } catch (err) {
      // requestPictureInPicture rejects on "user gesture required" or
      // "video is not playing" — we swallow because these are expected
      // edge cases, not bugs.
      logger.warn('[PiP] toggle failed:', err);
    }
  }, [videoRef, isSupported]);

  // Auto-on-hide visibility wiring. We attach a single listener that
  // bridges visibilitychange → toggle. Guarded on autoOnHide so the
  // hook stays pay-as-you-go.
  useEffect(() => {
    if (!isSupported || !autoOnHide) return;
    const onVisibility = async () => {
      const video = videoRef.current;
      if (!video) return;
      const hidden = document.visibilityState === 'hidden';
      const currentlyInPip = document.pictureInPictureElement === video;

      if (hidden && !currentlyInPip) {
        try {
          await video.requestPictureInPicture();
        } catch {
          // Most common rejection here: "user gesture required" — Safari
          // is strict about this. Not much to do; the manual toggle
          // button still works after any click.
        }
      } else if (!hidden && currentlyInPip) {
        try {
          await document.exitPictureInPicture();
        } catch {
          // Swallow — leaving PiP can race with the user closing the
          // PiP window themselves.
        }
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [autoOnHide, isSupported, videoRef]);

  return { isSupported, isActive, toggle };
}
