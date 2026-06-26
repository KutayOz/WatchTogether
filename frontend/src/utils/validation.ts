/**
 * Password validation rules — kept in sync with backend
 * (Business/Validators/PasswordValidator.cs). Same constraints, same
 * order, so the user sees the same checklist that the server will enforce.
 *
 * The shape is intentionally rule-by-rule (not a single boolean) so the
 * UI can show a live checklist with each rule lit/dark independently.
 */

export interface PasswordRule {
  id: 'length' | 'upper' | 'lower' | 'digit';
  label: string;
  test: (password: string) => boolean;
}

export const MIN_PASSWORD_LENGTH = 12;
export const MAX_PASSWORD_LENGTH = 256;

export const PASSWORD_RULES: PasswordRule[] = [
  {
    id: 'length',
    label: `at least ${MIN_PASSWORD_LENGTH} characters`,
    test: (p) => p.length >= MIN_PASSWORD_LENGTH,
  },
  { id: 'upper', label: 'one uppercase letter', test: (p) => /[A-Z]/.test(p) },
  { id: 'lower', label: 'one lowercase letter', test: (p) => /[a-z]/.test(p) },
  { id: 'digit', label: 'one number',           test: (p) => /[0-9]/.test(p) },
];

export interface PasswordEvaluation {
  /** Per-rule pass/fail state, same order as PASSWORD_RULES. */
  rules: { id: PasswordRule['id']; label: string; passed: boolean }[];
  /** True only when every rule passes. */
  valid: boolean;
  /** Convenience: error labels for failed rules (empty when valid). */
  errors: string[];
}

/**
 * Evaluate a password against every rule and return per-rule state. The
 * forms use this for the live checklist; the legacy validatePassword()
 * below stays around so existing call sites compile unchanged.
 */
export function evaluatePassword(password: string): PasswordEvaluation {
  const rules = PASSWORD_RULES.map((rule) => ({
    id: rule.id,
    label: rule.label,
    passed: !!password && rule.test(password),
  }));
  const errors = rules.filter((r) => !r.passed).map((r) => r.label);
  // Length cap is a hard upper bound — treat overflow as a separate error
  // so the user knows we capped them (matches backend MaxLength = 256).
  if (password && password.length > MAX_PASSWORD_LENGTH) {
    errors.push(`at most ${MAX_PASSWORD_LENGTH} characters`);
  }
  return {
    rules,
    valid: errors.length === 0 && !!password,
    errors,
  };
}

/**
 * Legacy shape — kept for backward compatibility with anywhere that
 * imports validatePassword. New code should prefer evaluatePassword().
 */
export interface PasswordValidationResult {
  valid: boolean;
  errors: string[];
}

export function validatePassword(password: string): PasswordValidationResult {
  if (!password) {
    return { valid: false, errors: ['Password is required'] };
  }
  const { valid, errors } = evaluatePassword(password);
  return { valid, errors };
}

export function validateEmail(email: string): boolean {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}
