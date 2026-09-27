import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';

type Variant = 'primary' | 'secondary' | 'ghost' | 'danger' | 'teal' | 'link';
type Size = 'sm' | 'md' | 'lg' | 'xl';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: Variant;
  size?: Size;
  /** Shows a spinner in place of the leading icon and marks the button busy. */
  loading?: boolean;
  icon?: ReactNode;
  iconAfter?: ReactNode;
  block?: boolean;
  /** Leans toward the cursor. For the one or two buttons a screen is about. */
  magnetic?: boolean;
}

/**
 * The button. Behaviour comes from attributes the interaction layer reads —
 * a cursor light on every variant, a press ripple, and a magnetic lean for the
 * primary call to action of a screen.
 */
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = 'secondary',
    size = 'md',
    loading = false,
    icon,
    iconAfter,
    block = false,
    magnetic = false,
    className,
    children,
    type = 'button',
    disabled,
    ...rest
  },
  ref,
) {
  const classes = [
    'btn',
    `btn--${variant}`,
    size !== 'md' && `btn--${size}`,
    block && 'btn--block',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      disabled={disabled}
      aria-busy={loading || undefined}
      data-light={variant === 'link' ? undefined : ''}
      data-ripple={variant === 'link' ? undefined : ''}
      data-magnetic={magnetic ? '' : undefined}
      {...rest}
    >
      {loading ? <span className="btn__spinner" aria-hidden="true" /> : icon}
      {children != null && <span>{children}</span>}
      {iconAfter}
    </button>
  );
});

export interface IconButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required: an icon button has no text, so this is its whole name. */
  label: string;
  size?: 'sm' | 'md' | 'lg';
  tone?: 'amber' | 'exit' | 'teal';
  bare?: boolean;
  /** Show the label as a hover tooltip (pointer devices). */
  tip?: boolean | 'below';
  children: ReactNode;
}

export const IconButton = forwardRef<HTMLButtonElement, IconButtonProps>(function IconButton(
  { label, size = 'md', tone, bare = false, tip = true, className, children, type = 'button', ...rest },
  ref,
) {
  const classes = [
    'icon-btn',
    size !== 'md' && `icon-btn--${size}`,
    bare && 'icon-btn--bare',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <button
      ref={ref}
      type={type}
      className={classes}
      aria-label={label}
      data-tone={tone}
      data-tip={tip ? label : undefined}
      data-tip-pos={tip === 'below' ? 'below' : undefined}
      data-ripple=""
      {...rest}
    >
      {children}
    </button>
  );
});
