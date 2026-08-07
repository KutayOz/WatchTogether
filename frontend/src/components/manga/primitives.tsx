import { useEffect, useId, useState, type CSSProperties, type ReactNode, type ButtonHTMLAttributes, type InputHTMLAttributes } from 'react';
import { Doodle, type AccentColor, type ToneKind } from './patterns';

/* ──────────────────────────────────────────────────────────── */
/* StickerButton                                               */
/* ──────────────────────────────────────────────────────────── */

interface StickerButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'color'> {
  color?: AccentColor;
  size?: 'sm' | 'md' | 'xl';
  sfx?: string | null;
  breathe?: boolean;
  sparks?: boolean;
  children: ReactNode;
}

export function StickerButton({
  children,
  color = 'pink',
  size = 'md',
  sfx = null,
  breathe = false,
  sparks = false,
  className = '',
  style,
  onClick,
  type = 'button',
  ...rest
}: StickerButtonProps) {
  const [bursts, setBursts] = useState<Array<{ id: number; label: string }>>([]);

  const handleClick: React.MouseEventHandler<HTMLButtonElement> = (e) => {
    if (sfx) {
      const id = Date.now() + Math.random();
      setBursts((b) => [...b, { id, label: sfx }]);
      window.setTimeout(() => setBursts((b) => b.filter((x) => x.id !== id)), 900);
    }
    onClick?.(e);
  };

  const sizeCls = size === 'sm' ? 'sm' : size === 'xl' ? 'xl' : '';

  return (
    <button
      type={type}
      onClick={handleClick}
      className={`sticker ${color} ${sizeCls} ${breathe ? 'breathe' : ''} ${className}`}
      style={style}
      {...rest}
    >
      {sparks && (
        <span aria-hidden="true" style={{ position: 'absolute', left: -16, top: -10 }}>
          <Doodle kind="sparkle" size={20} color="var(--orange)" />
        </span>
      )}
      {children}
      {bursts.map((b) => (
        <span
          key={b.id}
          aria-hidden="true"
          style={{
            position: 'absolute',
            left: '50%',
            top: 0,
            transform: 'translate(-50%, -100%) rotate(-12deg)',
            fontFamily: 'var(--font-sfx)',
            fontSize: 26,
            color: 'var(--ink)',
            textShadow: '3px 3px 0 var(--pink)',
            pointerEvents: 'none',
            animation: 'sfxRise .85s ease-out forwards',
          }}
        >
          {b.label}
        </span>
      ))}
    </button>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* SpeechBubble                                                */
/* ──────────────────────────────────────────────────────────── */

interface SpeechBubbleProps {
  kind?: 'cloud' | 'rect' | 'oval';
  side?: 'left' | 'right';
  color?: 'cream' | 'pink' | 'purple' | 'orange';
  children: ReactNode;
  style?: CSSProperties;
  small?: boolean;
  fontFamily?: string;
  align?: CSSProperties['textAlign'];
}

export function SpeechBubble({
  kind = 'cloud',
  side = 'left',
  color = 'cream',
  children,
  style,
  small = false,
  fontFamily,
  align = 'left',
}: SpeechBubbleProps) {
  const fill =
    color === 'pink' ? '#FF4FA3' :
    color === 'purple' ? '#7B3FE4' :
    color === 'orange' ? '#FF7A29' :
    '#FBF1DD';
  const fg = color === 'purple' ? 'var(--cream)' : 'var(--ink)';
  const padding = small ? '8px 12px' : '12px 16px';
  const fontSize = small ? 13 : 15;
  const family = fontFamily ?? 'var(--font-body)';

  if (kind === 'cloud') {
    const w = style?.width ?? (small ? 170 : 220);
    const h = style?.height ?? (small ? 100 : 130);
    return (
      <div style={{ position: 'relative', display: 'inline-block', width: w, height: h, ...style }}>
        <svg width={w as number} height={h as number} viewBox="0 0 240 140" preserveAspectRatio="none" style={{ position: 'absolute', inset: 0 }} aria-hidden="true">
          <path
            d="M30 70 Q 20 50, 40 42 Q 38 22, 62 24 Q 70 8, 96 16 Q 112 4, 134 18 Q 156 6, 174 22 Q 200 18, 204 42 Q 224 50, 214 70 Q 224 92, 198 100 Q 196 122, 170 116 Q 158 132, 132 122 Q 116 134, 96 122 Q 76 132, 62 118 Q 36 122, 36 100 Q 16 92, 30 70 Z"
            fill={fill}
            stroke="var(--ink)"
            strokeWidth={3.5}
            strokeLinejoin="round"
          />
          <circle cx={side === 'right' ? 200 : 40} cy="128" r="6" fill={fill} stroke="var(--ink)" strokeWidth={2.5} />
          <circle cx={side === 'right' ? 215 : 25} cy="138" r="4" fill={fill} stroke="var(--ink)" strokeWidth={2} />
        </svg>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            display: 'grid',
            placeItems: 'center',
            padding: small ? '10px 22px 18px' : '16px 30px 26px',
            color: fg,
            fontFamily: family,
            fontWeight: 700,
            fontSize,
            lineHeight: 1.2,
            textAlign: 'center',
            boxSizing: 'border-box',
          }}
        >
          {children}
        </div>
      </div>
    );
  }

  if (kind === 'rect') {
    return (
      <div className="bubble rect" style={{ background: fill, color: fg, padding, fontFamily: family, fontSize, ...style }}>
        {children}
      </div>
    );
  }

  // oval
  const radius = side === 'right' ? '22px 22px 6px 22px' : '22px 22px 22px 6px';
  return (
    <div style={{ position: 'relative', display: 'inline-block', ...style }}>
      <div
        style={{
          background: fill,
          color: fg,
          border: '3px solid var(--ink)',
          borderRadius: radius,
          padding,
          fontFamily: family,
          fontWeight: 600,
          fontSize,
          lineHeight: 1.35,
          maxWidth: 320,
          textAlign: align,
        }}
      >
        {children}
      </div>
      <svg
        width="34"
        height="26"
        style={{
          position: 'absolute',
          bottom: -20,
          [side === 'right' ? 'right' : 'left']: 10,
          overflow: 'visible',
          transform: side === 'right' ? 'scaleX(-1)' : 'none',
          transformOrigin: 'right top',
        }}
        viewBox="0 0 34 26"
        aria-hidden="true"
      >
        <path d="M2 0 Q 0 16 6 22 Q 14 26 16 22 L 32 0 Z" fill={fill} stroke="var(--ink)" strokeWidth="3" strokeLinejoin="round" strokeLinecap="round" />
        <line x1="3" y1="0" x2="31" y2="0" stroke={fill} strokeWidth="4" />
      </svg>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* ComicPanel                                                  */
/* ──────────────────────────────────────────────────────────── */

interface ComicPanelProps {
  children: ReactNode;
  rotate?: number;
  shadow?: 'ink' | 'pink' | 'purple' | 'none';
  pad?: number;
  style?: CSSProperties;
  className?: string;
  bleed?: boolean;
  borderWidth?: number;
  tone?: ToneKind | null;
}

export function ComicPanel({
  children,
  rotate = 0.6,
  shadow = 'ink',
  pad = 18,
  style,
  className = '',
  bleed = false,
  borderWidth = 4,
  tone = null,
}: ComicPanelProps) {
  const shadowMap: Record<'ink' | 'pink' | 'purple' | 'none', string> = {
    ink: '7px 7px 0 var(--ink)',
    pink: '7px 7px 0 var(--pink), 7px 7px 0 0 var(--ink)',
    purple: '7px 7px 0 var(--purple)',
    none: 'none',
  };
  return (
    <div
      className={className}
      style={{
        position: 'relative',
        background: 'var(--cream)',
        border: `${borderWidth}px solid var(--ink)`,
        borderRadius: 4,
        padding: pad,
        boxShadow: shadowMap[shadow],
        transform: `rotate(calc(var(--wobble) * ${rotate} * var(--rotate-mul)))`,
        overflow: bleed ? 'visible' : 'hidden',
        ...style,
      }}
    >
      {tone && (
        <svg style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', pointerEvents: 'none', opacity: 0.7 }} aria-hidden="true">
          <rect width="100%" height="100%" fill={`url(#tone-${tone})`} />
        </svg>
      )}
      <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* InkInput                                                    */
/* ──────────────────────────────────────────────────────────── */

interface InkInputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'color'> {
  label?: ReactNode;
  hint?: ReactNode;
  error?: ReactNode;
}

export function InkInput({ label, hint, error, ...rest }: InkInputProps) {
  return (
    <label style={{ display: 'block', position: 'relative', width: '100%' }}>
      {label && (
        <span className="hand" style={{ display: 'block', fontSize: 20, marginBottom: 4, color: 'var(--ink)' }}>
          {label}
        </span>
      )}
      <input className="ink-input" {...rest} />
      {hint && !error && (
        <span className="hand" style={{ display: 'block', marginTop: 4, fontSize: 16, color: 'rgba(26,20,23,0.6)' }}>
          {hint}
        </span>
      )}
      {error && (
        <div className="shake hand" style={{ marginTop: 6, color: 'var(--orange-deep)', fontSize: 18 }}>
          {error}
        </div>
      )}
    </label>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* SectionTitle                                                */
/* ──────────────────────────────────────────────────────────── */

interface SectionTitleProps {
  children: ReactNode;
  size?: number;
  color?: string;
  underline?: AccentColor;
  style?: CSSProperties;
}

export function SectionTitle({
  children,
  size = 56,
  color = 'var(--ink)',
  underline = 'pink',
  style,
}: SectionTitleProps) {
  return (
    <div style={{ display: 'inline-block', position: 'relative', ...style }}>
      <h2
        style={{
          fontFamily: 'var(--font-sfx)',
          fontSize: size,
          lineHeight: 1,
          letterSpacing: 1.5,
          margin: 0,
          color,
        }}
      >
        {children}
      </h2>
      <svg
        width="100%"
        height="14"
        viewBox="0 0 200 14"
        preserveAspectRatio="none"
        style={{ position: 'absolute', left: 0, bottom: -10 }}
        aria-hidden="true"
      >
        <path d="M2 8 C 60 2, 120 14, 198 6" stroke={`var(--${underline})`} strokeWidth="4" fill="none" strokeLinecap="round" />
      </svg>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Sketchbook                                                  */
/* ──────────────────────────────────────────────────────────── */

interface SketchbookProps {
  children: ReactNode;
  style?: CSSProperties;
}

export function Sketchbook({ children, style }: SketchbookProps) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'auto 1fr',
        gap: 0,
        background: 'var(--cream)',
        border: '3.5px solid var(--ink)',
        borderRadius: 8,
        boxShadow: '10px 10px 0 var(--ink)',
        position: 'relative',
        overflow: 'hidden',
        ...style,
      }}
    >
      <div className="spiral" style={{ background: 'rgba(26,20,23,0.04)', borderRight: '3px dashed var(--ink)' }}>
        {Array.from({ length: 12 }, (_, i) => <span key={i} className="hole" />)}
      </div>
      <div style={{ padding: '28px 36px 32px', position: 'relative' }}>
        <div
          style={{
            position: 'absolute',
            inset: 0,
            backgroundImage:
              'repeating-linear-gradient(0deg, transparent 0 31px, rgba(123,63,228,0.18) 31px 32px)',
            pointerEvents: 'none',
          }}
        />
        <div style={{ position: 'relative', zIndex: 1 }}>{children}</div>
      </div>
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* NotebookField — text input that looks like writing on a     */
/* ruled notebook line. Label sits inline as purple handwriting. */
/* ──────────────────────────────────────────────────────────── */

interface NotebookFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'value' | 'type'> {
  label: string;
  value: string;
  onChange: (value: string) => void;
  type?: string;
  hint?: ReactNode;
  /**
   * Optional slot rendered at the right edge of the underline, on the same
   * baseline as the input. Used for things like a show/hide-password toggle
   * — kept inside the ruled-line metaphor so it visually belongs to the field.
   */
  rightAdornment?: ReactNode;
}

export function NotebookField({ label, value, onChange, placeholder, type = 'text', hint, rightAdornment, ...rest }: NotebookFieldProps) {
  /**
   * A real <label for>, not a decorative <span>.
   *
   * The label used to be an unassociated span, which looked identical and left
   * every field in the app with no accessible name at all — nothing for a
   * screen reader to announce, and nothing for getByLabel to find. Clicking the
   * word did not focus the input either.
   */
  const inputId = useId();

  return (
    <div style={{ marginTop: 12, marginBottom: 4 }}>
      <div
        style={{
          display: 'flex',
          alignItems: 'flex-end',
          gap: 10,
          borderBottom: '2px solid rgba(123, 63, 228, 0.45)',
          paddingBottom: 4,
        }}
      >
        <label
          htmlFor={inputId}
          style={{
            fontFamily: 'var(--font-hand)',
            fontWeight: 700,
            fontSize: 26,
            color: 'var(--purple)',
            lineHeight: 1,
            whiteSpace: 'nowrap',
          }}
        >
          {label}
        </label>
        <input
          id={inputId}
          type={type}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          className="notebook-field-input"
          style={{
            flex: 1,
            minWidth: 0,
            background: 'transparent',
            border: 'none',
            outline: 'none',
            fontFamily: 'var(--font-hand)',
            fontWeight: 600,
            fontSize: 26,
            color: 'var(--ink)',
            padding: 0,
            lineHeight: 1.1,
            caretColor: 'var(--pink)',
          }}
          {...rest}
        />
        {rightAdornment && (
          <span style={{ display: 'inline-flex', alignItems: 'center', flexShrink: 0 }}>
            {rightAdornment}
          </span>
        )}
      </div>
      {hint && (
        <span className="hand" style={{ display: 'block', fontSize: 16, marginTop: 4, color: 'rgba(26,20,23,0.55)' }}>
          {hint}
        </span>
      )}
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* BackButton                                                  */
/* ──────────────────────────────────────────────────────────── */

interface BackButtonProps {
  children?: ReactNode;
  onClick?: () => void;
  color?: 'cream' | 'pink' | 'purple';
  style?: CSSProperties;
}

export function BackButton({ children = 'back', onClick, color = 'cream', style }: BackButtonProps) {
  const bg =
    color === 'purple' ? 'var(--purple)' :
    color === 'pink' ? 'var(--pink)' :
    'var(--cream)';
  const fg = color === 'purple' ? 'var(--cream)' : 'var(--ink)';

  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 8,
        background: bg,
        color: fg,
        border: '3px solid var(--ink)',
        borderRadius: 999,
        padding: '8px 18px 8px 12px',
        fontFamily: 'var(--font-hand)',
        fontWeight: 700,
        fontSize: 22,
        cursor: 'pointer',
        boxShadow: '4px 4px 0 var(--ink)',
        transform: 'rotate(-2deg)',
        transition: 'transform .18s cubic-bezier(.34,1.7,.64,1), box-shadow .18s, background .18s',
        position: 'relative',
        ...style,
      }}
      onMouseEnter={(e) => {
        e.currentTarget.style.transform = 'rotate(0) translate(-2px,-2px) scale(1.05)';
        e.currentTarget.style.boxShadow = '6px 6px 0 var(--ink)';
      }}
      onMouseLeave={(e) => {
        e.currentTarget.style.transform = 'rotate(-2deg)';
        e.currentTarget.style.boxShadow = '4px 4px 0 var(--ink)';
      }}
    >
      <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 26, lineHeight: 1, marginTop: -2 }}>←</span>
      <span>{children}</span>
    </button>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Modal                                                       */
/* ──────────────────────────────────────────────────────────── */

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title?: ReactNode;
  /**
   * Top-stripe + shadow accent. Matches StickerButton color vocabulary so
   * a "Demo approved" modal can read pink while a "Confirm rejection" modal
   * reads orange — without each callsite reinventing the styling.
   */
  accent?: AccentColor;
  /** Block backdrop-click + ESC dismissal. Useful for "must finish" flows
   *  (e.g. reject confirmation while the request is in flight). */
  blocking?: boolean;
  maxWidth?: number;
  children: ReactNode;
}

export function Modal({
  isOpen,
  onClose,
  title,
  accent = 'pink',
  blocking = false,
  maxWidth = 560,
  children,
}: ModalProps) {
  // ESC-to-close. Attached to window so it catches the key even when focus
  // is inside an input child. Effect runs on every isOpen/blocking change —
  // when closed or blocking, the listener is absent. The hook itself runs
  // unconditionally so React's hook-order invariant is preserved across the
  // early-return below.
  useEffect(() => {
    if (!isOpen || blocking) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, blocking, onClose]);

  if (!isOpen) return null;

  const accentVar = `var(--${accent})`;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={typeof title === 'string' ? title : 'dialog'}
      onClick={blocking ? undefined : onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,20,23,0.55)',
        zIndex: 8000,
        display: 'grid',
        placeItems: 'center',
        padding: 16,
        animation: 'fadeIn 0.18s ease-out forwards',
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width: '100%',
          maxWidth,
          background: 'var(--cream)',
          border: '4px solid var(--ink)',
          borderRadius: 6,
          boxShadow: `7px 7px 0 ${accentVar}, 7px 7px 0 0 var(--ink)`,
          transform: 'rotate(-0.4deg)',
          padding: '24px 26px',
          position: 'relative',
        }}
      >
        {/* Top accent stripe — small visual rhyme with the SectionTitle
            underline used everywhere else, so the modal feels native to
            the rest of the manga UI. */}
        <div
          aria-hidden="true"
          style={{
            position: 'absolute',
            top: 0,
            left: 16,
            right: 16,
            height: 4,
            background: accentVar,
            transform: 'translateY(-2px)',
          }}
        />

        {/* Close X — always present even when blocking=true so the user can
            cancel if something goes really wrong. blocking just removes the
            backdrop-click + ESC affordances. */}
        <button
          type="button"
          onClick={onClose}
          aria-label="close"
          style={{
            position: 'absolute',
            top: 8,
            right: 12,
            background: 'transparent',
            border: 'none',
            fontFamily: 'var(--font-sfx)',
            fontSize: 26,
            color: 'var(--ink)',
            cursor: 'pointer',
            lineHeight: 1,
            padding: 4,
          }}
        >
          ×
        </button>

        {title && (
          <div style={{ marginBottom: 14, marginRight: 28 }}>
            <SectionTitle size={32} underline={accent}>
              {title}
            </SectionTitle>
          </div>
        )}

        <div>{children}</div>
      </div>
    </div>
  );
}
