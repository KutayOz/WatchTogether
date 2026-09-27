import { useId, type ReactNode } from 'react';
import { m } from 'motion/react';
import { spring } from './motion';

export interface SegmentedOption<T extends string> {
  value: T;
  label: ReactNode;
  icon?: ReactNode;
}

interface SegmentedProps<T extends string> {
  /** Accessible name for the group. */
  legend: string;
  name: string;
  value: T;
  options: SegmentedOption<T>[];
  onChange: (value: T) => void;
  disabled?: boolean;
  className?: string;
}

/**
 * A radio group drawn as one capsule with a lit thumb that slides to the
 * choice. The inputs are real radios laid invisibly over each option, so the
 * group behaves exactly like native radios — arrow keys, labels, screen
 * readers, form semantics — and only the thumb is ours.
 */
export function Segmented<T extends string>({
  legend,
  name,
  value,
  options,
  onChange,
  disabled,
  className,
}: SegmentedProps<T>) {
  const groupId = useId();
  return (
    <div
      role="radiogroup"
      aria-label={legend}
      className={['segmented', className].filter(Boolean).join(' ')}
    >
      {options.map((option) => {
        const checked = option.value === value;
        return (
          <label key={option.value} className="segmented__option" data-checked={checked ? '' : undefined}>
            <input
              type="radio"
              className="segmented__input"
              name={name}
              value={option.value}
              checked={checked}
              disabled={disabled}
              onChange={() => onChange(option.value)}
            />
            {checked && (
              <m.span
                layoutId={`${groupId}-thumb`}
                className="segmented__thumb"
                transition={spring.snappy}
                aria-hidden="true"
              />
            )}
            {option.icon}
            <span>{option.label}</span>
          </label>
        );
      })}
    </div>
  );
}
