import {
  USERNAME_ERROR_MESSAGES,
  USERNAME_MAX_LENGTH,
  normalizeUsername,
} from '@shared/identity';
import { NotebookField } from '../manga';

/**
 * Username input, validated against the Worker's own rules.
 *
 * `normalizeUsername` is imported from the Worker rather than reimplemented, so
 * the client cannot accept a name the server will reject — the classic version
 * of that bug being a client regex that allows a character the server strips,
 * producing an error the user cannot see the cause of. Same function, same
 * reserved list, same NFKC normalisation.
 *
 * The check is advisory: the server validates again regardless, since anything
 * here can be bypassed.
 */
export function UsernameField({
  label = 'username:',
  value,
  onChange,
  disabled,
  autoFocus,
}: {
  label?: string;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
  autoFocus?: boolean;
}) {
  const trimmed = value.trim();
  const result = trimmed ? normalizeUsername(trimmed) : null;
  const problem = result && !result.ok ? USERNAME_ERROR_MESSAGES[result.error] : null;

  return (
    <div>
      <NotebookField
        label={label}
        value={value}
        onChange={onChange}
        placeholder="pick a name"
        disabled={disabled}
        autoFocus={autoFocus}
        maxLength={USERNAME_MAX_LENGTH}
      />

      {problem ? (
        <div
          className="hand"
          aria-live="polite"
          style={{ marginTop: 4, color: 'var(--orange-deep)', fontSize: 18 }}
        >
          · {problem}
        </div>
      ) : (
        <div
          className="hand"
          style={{ marginTop: 4, fontSize: 17, color: 'rgba(26,20,23,0.55)' }}
        >
          {/* Explaining the discriminator up front stops the number reading as a
              mistake when it appears on the next screen. */}
          you'll get a number too — like{' '}
          <span style={{ color: 'var(--purple)' }}>{trimmed || 'name'}#0042</span> — so two people
          can share a name
        </div>
      )}
    </div>
  );
}

