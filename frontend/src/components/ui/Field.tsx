import {
  forwardRef,
  useId,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';

interface FieldFrameProps {
  id: string;
  label: ReactNode;
  /** Quiet trailing note on the label, e.g. "optional". */
  note?: ReactNode;
  hint?: ReactNode;
  /** When set, replaces the hint and marks the field invalid. */
  problem?: ReactNode;
  /** Right-aligned text in the footer row, e.g. a character count. */
  aside?: ReactNode;
  adornment?: ReactNode;
  /** Extra content under the control, before the footer (e.g. a meter). */
  below?: ReactNode;
  children: ReactNode;
  className?: string;
}

/**
 * Label, control, and one line of help under it — which turns into the
 * problem when there is one. The help line always occupies its space so a
 * message appearing does not shove the rest of the form down.
 */
export function FieldFrame({
  id,
  label,
  note,
  hint,
  problem,
  aside,
  adornment,
  below,
  children,
  className,
}: FieldFrameProps) {
  const footId = `${id}-foot`;
  return (
    <div className={['field', className].filter(Boolean).join(' ')} data-invalid={problem ? '' : undefined}>
      <label className="field__label" htmlFor={id}>
        {label}
        {note && <span className="field__label-note"> {note}</span>}
      </label>
      <div className="field__control">
        {children}
        {adornment && <div className="field__adorn">{adornment}</div>}
      </div>
      {below}
      {(hint || problem || aside) && (
        <div className="field__foot" id={footId}>
          <span aria-live="polite" data-problem={problem ? '' : undefined}>
            {problem ?? hint}
          </span>
          {aside && <span className="tabular">{aside}</span>}
        </div>
      )}
    </div>
  );
}

export interface TextFieldProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange'> {
  label: ReactNode;
  note?: ReactNode;
  hint?: ReactNode;
  problem?: ReactNode;
  aside?: ReactNode;
  adornment?: ReactNode;
  below?: ReactNode;
  onValueChange?: (value: string) => void;
  onChange?: InputHTMLAttributes<HTMLInputElement>['onChange'];
}

export const TextField = forwardRef<HTMLInputElement, TextFieldProps>(function TextField(
  { label, note, hint, problem, aside, adornment, below, onValueChange, onChange, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const described = hint || problem || aside ? `${inputId}-foot` : undefined;
  return (
    <FieldFrame
      id={inputId}
      label={label}
      note={note}
      hint={hint}
      problem={problem}
      aside={aside}
      adornment={adornment}
      below={below}
      className={className}
    >
      <input
        ref={ref}
        id={inputId}
        className="field__input"
        aria-invalid={problem ? true : undefined}
        aria-describedby={described}
        onChange={(e) => {
          onChange?.(e);
          onValueChange?.(e.target.value);
        }}
        {...rest}
      />
    </FieldFrame>
  );
});

export interface TextAreaProps extends Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange'> {
  label: ReactNode;
  note?: ReactNode;
  hint?: ReactNode;
  problem?: ReactNode;
  aside?: ReactNode;
  onValueChange?: (value: string) => void;
}

export const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { label, note, hint, problem, aside, onValueChange, className, id, ...rest },
  ref,
) {
  const autoId = useId();
  const inputId = id ?? autoId;
  const described = hint || problem || aside ? `${inputId}-foot` : undefined;
  return (
    <FieldFrame
      id={inputId}
      label={label}
      note={note}
      hint={hint}
      problem={problem}
      aside={aside}
      className={className}
    >
      <textarea
        ref={ref}
        id={inputId}
        className="field__input"
        aria-invalid={problem ? true : undefined}
        aria-describedby={described}
        onChange={(e) => onValueChange?.(e.target.value)}
        {...rest}
      />
    </FieldFrame>
  );
});
