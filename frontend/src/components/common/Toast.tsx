import { useEffect, useRef, useState } from 'react';
import { m, type PanInfo } from 'motion/react';
import { IconButton } from '../ui/Button';
import { AlertIcon, CheckIcon, CloseIcon, InfoIcon } from '../ui/icons';
import { spring } from '../ui/motion';
import { PHONE, useMediaQuery } from '../ui/useMediaQuery';

interface ToastProps {
  message: string;
  type?: 'info' | 'success' | 'warning' | 'error';
  /**
   * Override auto-dismiss duration. If omitted, picks a sensible default
   * per type — errors stick around longer than info chimes because
   * "your camera permission was denied" needs more than 4 seconds of
   * reading time.
   */
  duration?: number;
  onClose: () => void;
}

// Auto-dismiss budgets per severity. Errors/warnings carry information the
// user might need to act on, so they get more reading time. Manual dismiss is
// always available regardless, and hovering holds the clock.
const DEFAULT_DURATIONS: Record<NonNullable<ToastProps['type']>, number> = {
  info: 4000,
  success: 4000,
  warning: 6500,
  error: 8000,
};

/**
 * A notification that slides in, counts itself down along its bottom edge,
 * and can be swiped away. Hovering pauses the countdown, so a message being
 * read does not leave mid-sentence.
 *
 * Presence is the caller's: render it inside AnimatePresence, keyed per
 * message, and the exit plays when onClose clears it.
 *
 * Accessibility:
 *   - role="alert" + aria-live="assertive" for warning/error
 *   - role="status" + aria-live="polite" for info/success
 *   - an explicit close button, so keyboard users can dismiss early
 */
export function Toast({ message, type = 'info', duration, onClose }: ToastProps) {
  const total = duration ?? DEFAULT_DURATIONS[type];
  const isUrgent = type === 'warning' || type === 'error';
  const isPhone = useMediaQuery(PHONE);
  const [paused, setPaused] = useState(false);

  // Remaining time survives pauses: each resume schedules only what is left.
  const remainingRef = useRef(total);
  const startedAtRef = useRef(0);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (paused) return;
    startedAtRef.current = performance.now();
    const timer = window.setTimeout(() => onCloseRef.current(), remainingRef.current);
    return () => {
      window.clearTimeout(timer);
      remainingRef.current = Math.max(0, remainingRef.current - (performance.now() - startedAtRef.current));
    };
  }, [paused]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (Math.abs(info.offset.x) > 90 || Math.abs(info.velocity.x) > 500) onClose();
  };

  const Icon = type === 'success' ? CheckIcon : isUrgent ? AlertIcon : InfoIcon;

  return (
    <div className="toast-region">
      <m.div
        role={isUrgent ? 'alert' : 'status'}
        aria-live={isUrgent ? 'assertive' : 'polite'}
        className="toast"
        data-type={type}
        initial={isPhone ? { opacity: 0, y: 40, scale: 0.96 } : { opacity: 0, x: 48, scale: 0.96 }}
        animate={{ opacity: 1, x: 0, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: 0.94, transition: { duration: 0.18 } }}
        transition={spring.lively}
        drag="x"
        dragSnapToOrigin
        dragElastic={0.5}
        onDragEnd={onDragEnd}
        onPointerEnter={() => setPaused(true)}
        onPointerLeave={() => setPaused(false)}
        onFocusCapture={() => setPaused(true)}
        onBlurCapture={() => setPaused(false)}
      >
        <span className="toast__icon" aria-hidden="true">
          <Icon size={16} />
        </span>
        <span className="toast__msg">{message}</span>
        <IconButton label="Dismiss notification" size="sm" bare tip={false} onClick={onClose}>
          <CloseIcon size={16} />
        </IconButton>
        {/* CSS rather than JS: the bar and the timeout pause on the same
            event, and animation-play-state freezes it exactly where it is. */}
        <span
          className="toast__timer"
          aria-hidden="true"
          style={{ animationDuration: `${total}ms`, animationPlayState: paused ? 'paused' : 'running' }}
        />
      </m.div>
    </div>
  );
}
