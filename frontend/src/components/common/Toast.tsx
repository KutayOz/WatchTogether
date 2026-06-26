import { useEffect, useState } from 'react';

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

const KIND_STYLES: Record<NonNullable<ToastProps['type']>, { bg: string; fg: string; label: string }> = {
  info:    { bg: 'var(--purple)', fg: 'var(--cream)', label: 'PSST' },
  success: { bg: 'var(--pink)',   fg: 'var(--ink)',   label: 'YES!' },
  warning: { bg: 'var(--orange)', fg: 'var(--ink)',   label: 'HEADS UP' },
  error:   { bg: 'var(--orange)', fg: 'var(--ink)',   label: 'OOPS!' },
};

// Auto-dismiss budgets per severity. Errors/warnings carry information the
// user might need to act on, so they get more reading time. Tuned by feel —
// 4 s reads as "drive-by" and 8 s reads as "stop and read this." Manual
// dismiss is always available regardless.
const DEFAULT_DURATIONS: Record<NonNullable<ToastProps['type']>, number> = {
  info:    4000,
  success: 4000,
  warning: 6500,
  error:   8000,
};

/**
 * Toast — comic-burst sticker that pops in from the top-right and fades.
 *
 * Accessibility:
 *   - role="alert" + aria-live="assertive" for warning/error (screen reader
 *     interrupts to announce)
 *   - role="status" + aria-live="polite" for info/success (announced at
 *     a natural pause, doesn't barge in)
 *   - Explicit close button with sr-only label so keyboard users can dismiss
 *     before the auto-timer (clicking the toast body still works for mouse)
 */
export function Toast({ message, type = 'info', duration, onClose }: ToastProps) {
  const [isVisible, setIsVisible] = useState(true);
  const effectiveDuration = duration ?? DEFAULT_DURATIONS[type];

  useEffect(() => {
    const timer = window.setTimeout(() => {
      setIsVisible(false);
      window.setTimeout(onClose, 300);
    }, effectiveDuration);

    return () => window.clearTimeout(timer);
  }, [effectiveDuration, onClose]);

  const styles = KIND_STYLES[type];
  const isUrgent = type === 'warning' || type === 'error';

  const dismiss = (e?: React.MouseEvent | React.KeyboardEvent) => {
    e?.stopPropagation();
    setIsVisible(false);
    window.setTimeout(onClose, 300);
  };

  return (
    <div
      role={isUrgent ? 'alert' : 'status'}
      aria-live={isUrgent ? 'assertive' : 'polite'}
      style={{
        position: 'fixed',
        top: 16,
        right: 16,
        zIndex: 9500,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 16px 12px 20px',
        background: styles.bg,
        color: styles.fg,
        border: '3.5px solid var(--ink)',
        borderRadius: 14,
        boxShadow: '6px 6px 0 var(--ink)',
        fontFamily: 'var(--font-body)',
        fontWeight: 700,
        fontSize: 14,
        maxWidth: 360,
        transform: `rotate(${isVisible ? -2 : 6}deg) translateY(${isVisible ? 0 : -8}px)`,
        opacity: isVisible ? 1 : 0,
        transition: 'transform .3s cubic-bezier(.34,1.7,.64,1), opacity .3s',
        cursor: 'pointer',
      }}
      onClick={() => dismiss()}
    >
      <span
        style={{
          fontFamily: 'var(--font-sfx)',
          fontSize: 16,
          letterSpacing: 1.5,
          padding: '4px 10px 2px',
          background: 'var(--cream)',
          color: 'var(--ink)',
          border: '2.5px solid var(--ink)',
          borderRadius: 999,
          flexShrink: 0,
        }}
      >
        {styles.label}
      </span>
      <span style={{ lineHeight: 1.3, flex: 1 }}>{message}</span>
      <button
        type="button"
        onClick={(e) => dismiss(e)}
        aria-label="dismiss notification"
        style={{
          background: 'transparent',
          border: 'none',
          color: styles.fg,
          fontFamily: 'var(--font-sfx)',
          fontSize: 20,
          padding: '0 4px',
          cursor: 'pointer',
          lineHeight: 1,
          // Slightly faded so it doesn't compete with the message itself —
          // it's a tertiary action.
          opacity: 0.7,
          flexShrink: 0,
        }}
      >
        ×
      </button>
    </div>
  );
}
