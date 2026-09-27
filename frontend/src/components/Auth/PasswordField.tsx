import { useState } from 'react';
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from '@shared/password';
import { TextField } from '../ui/Field';
import { describePassword } from '../../utils/password';

/**
 * Password input with a show/hide toggle, validated against the Worker's rules.
 *
 * Validation is advisory in a stronger sense than UsernameField's: the server
 * receives a derived key and *cannot* re-check any of it. That is a deliberate
 * consequence of doing the stretching in the browser — see @shared/password —
 * and the reason it is acceptable is that a bypassed rule here weakens exactly
 * one account, the bypasser's own.
 *
 * A new password also gets a thin line under it that fills toward the minimum
 * length and turns teal once the password passes every rule — so "long enough"
 * is visible while typing rather than discovered on submit.
 */
export function PasswordField({
  label = 'Password',
  value,
  onChange,
  username,
  autoComplete,
  disabled,
  autoFocus,
  placeholder,
  /** Suppresses the rulebook nagging on a sign-in field, where it is noise. */
  validate = true,
  hint,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  /** Used for the "must not contain your username" rule. */
  username?: string;
  autoComplete?: 'current-password' | 'new-password';
  disabled?: boolean;
  autoFocus?: boolean;
  placeholder?: string;
  validate?: boolean;
  hint?: string;
}) {
  const [revealed, setRevealed] = useState(false);
  const problem = validate ? describePassword(value, username) : null;
  const showMeter = validate && autoComplete === 'new-password';
  const progress = Math.min(1, value.length / PASSWORD_MIN_LENGTH);

  return (
    <TextField
      label={label}
      value={value}
      onValueChange={onChange}
      type={revealed ? 'text' : 'password'}
      placeholder={placeholder}
      disabled={disabled}
      autoFocus={autoFocus}
      autoComplete={autoComplete}
      maxLength={PASSWORD_MAX_LENGTH}
      spellCheck={false}
      autoCapitalize="none"
      autoCorrect="off"
      problem={problem}
      hint={hint}
      adornment={
        <button
          type="button"
          className="reveal-toggle"
          // Not a submit button. Inside a <form> an untyped button defaults to
          // submit, so revealing the password would post the form.
          onClick={() => setRevealed((shown) => !shown)}
          aria-label={revealed ? 'Hide password' : 'Show password'}
          aria-pressed={revealed}
          disabled={disabled}
        >
          {revealed ? 'Hide' : 'Show'}
        </button>
      }
      below={
        showMeter ? (
          <div className="meter-line" data-full={progress >= 1 && !problem ? '' : undefined} aria-hidden="true">
            <span style={{ transform: `scaleX(${progress})` }} />
          </div>
        ) : undefined
      }
    />
  );
}
