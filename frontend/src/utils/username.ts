import { normalizeUsername } from '@shared/identity';

/**
 * Whether a typed username would survive server-side validation.
 *
 * Wraps the Worker's own `normalizeUsername` rather than reimplementing its
 * rules, so the button cannot enable for a name the server will reject. The
 * check is advisory — the server validates again regardless, since anything
 * here is bypassable.
 */
export function isUsernameValid(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && normalizeUsername(trimmed).ok;
}
