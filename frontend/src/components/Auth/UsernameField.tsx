import {
  USERNAME_ERROR_MESSAGES,
  USERNAME_MAX_LENGTH,
  normalizeUsername,
} from '@shared/identity';
import { TextField } from '../ui/Field';

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
  label = 'Username',
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
    <TextField
      label={label}
      value={value}
      onValueChange={onChange}
      placeholder="Pick a name"
      disabled={disabled}
      autoFocus={autoFocus}
      maxLength={USERNAME_MAX_LENGTH}
      autoComplete="username"
      autoCapitalize="none"
      autoCorrect="off"
      spellCheck={false}
      problem={problem}
      hint={
        // Explaining the discriminator up front stops the number reading as a
        // mistake when it appears on the next screen.
        <>
          You also get a number, like <span style={{ color: 'var(--amber)' }}>{trimmed || 'name'}#0042</span>, so
          two people can share a name.
        </>
      }
    />
  );
}
