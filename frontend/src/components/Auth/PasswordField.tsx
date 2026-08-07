import { useId, useState } from 'react';
import { PASSWORD_MAX_LENGTH } from '@shared/password';
import { NotebookField } from '../manga';
import { describePassword } from '../../utils/password';

/**
 * Password input with a show/hide toggle, validated against the Worker's rules.
 *
 * `rightAdornment` on NotebookField exists for precisely this toggle, which is
 * why the field is built out of the design system rather than out of a bare
 * `<input>` the way the first-run setup-secret box on the login screen still is.
 *
 * Validation is advisory in a stronger sense than UsernameField's: the server
 * receives a derived key and *cannot* re-check any of it. That is a deliberate
 * consequence of doing the stretching in the browser — see @shared/password —
 * and the reason it is acceptable is that a bypassed rule here weakens exactly
 * one account, the bypasser's own.
 */
export function PasswordField({
  label = 'password:',
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
  const describedBy = useId();

  return (
    <div>
      <NotebookField
        label={label}
        value={value}
        onChange={onChange}
        type={revealed ? 'text' : 'password'}
        placeholder={placeholder}
        disabled={disabled}
        autoFocus={autoFocus}
        autoComplete={autoComplete}
        maxLength={PASSWORD_MAX_LENGTH}
        aria-describedby={describedBy}
        rightAdornment={
          <button
            type="button"
            onClick={() => setRevealed((shown) => !shown)}
            className="hand"
            // Not a submit button. Inside a <form> an untyped button defaults to
            // submit, so revealing the password would post the form.
            aria-label={revealed ? 'Hide password' : 'Show password'}
            style={{
              background: 'none',
              border: 'none',
              cursor: 'pointer',
              padding: '0 2px',
              fontSize: 17,
              color: 'var(--purple)',
              textDecoration: 'underline dashed',
            }}
          >
            {revealed ? 'hide' : 'show'}
          </button>
        }
      />

      {problem ? (
        <div
          id={describedBy}
          className="hand"
          aria-live="polite"
          style={{ marginTop: 4, color: 'var(--orange-deep)', fontSize: 18 }}
        >
          · {problem}
        </div>
      ) : (
        <div
          id={describedBy}
          className="hand"
          style={{ marginTop: 4, fontSize: 17, color: 'rgba(26,20,23,0.55)' }}
        >
          {hint}
        </div>
      )}
    </div>
  );
}
