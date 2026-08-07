import {
  CLIENT_KDF_VERSION,
  PASSWORD_ERROR_MESSAGES,
  deriveClientKey,
  normalizePassword,
} from '@shared/password';
import { normalizeUsername, parseTag } from '@shared/identity';
import type { PasswordCredential } from '../types';

/**
 * The browser's half of password handling.
 *
 * Sits in utils/ rather than components/Auth/ on purpose: vite.config.ts groups
 * that folder into the `auth` chunk, and anything importing from there gives its
 * own chunk a hard dependency edge on the whole of it. This is imported from
 * three screens in two different chunks, so it belongs in neither.
 *
 * Rules come from @shared/password — the Worker's own module — rather than being
 * restated here, for the same reason utils/username.ts wraps normalizeUsername:
 * a second copy of the rules is a second thing to keep in step. Unlike the
 * username case the server genuinely cannot re-check these, because it never
 * receives the password; see the header of @shared/password for why that is an
 * acceptable trade and not an oversight.
 */

/**
 * Turn a typed password into the credential the API takes.
 *
 * This is the only place plaintext becomes a wire value, and the derivation is
 * deliberately not optional: services/api.ts has no `password` parameter to
 * accidentally pass one to.
 *
 * Costs a few hundred milliseconds — 600,000 PBKDF2 iterations — so callers
 * must already be showing a busy state. That cost is the feature.
 */
export function buildPasswordCredential(
  password: string,
  usernameLower: string,
): Promise<PasswordCredential> {
  return deriveClientKey(password, usernameLower).then((clientKey) => ({
    clientKey,
    clientKdfVersion: CLIENT_KDF_VERSION,
  }));
}

/**
 * The lowercase username a key must be salted with.
 *
 * Sign-up has the username to hand; sign-in has a full `name#1234` handle and
 * has to take it apart. Getting this wrong does not fail loudly — it derives a
 * perfectly valid key for the wrong salt and the server simply says the
 * credentials do not match.
 */
export function saltUsernameFromTag(tag: string): string | null {
  const parsed = parseTag(tag.trim());
  if (!parsed) return null;

  const username = normalizeUsername(parsed.username);
  return username.ok ? username.value.usernameLower : null;
}

/** Whether a handle is complete enough to try. Gates the sign-in button. */
export function isTagValid(tag: string): boolean {
  return saltUsernameFromTag(tag) !== null;
}

/**
 * A human-readable objection to a password, or null if there is none.
 *
 * Returns null for an empty field too: an untouched input is not yet wrong, and
 * shouting at someone before they have typed anything is its own bug.
 */
export function describePassword(password: string, username?: string): string | null {
  if (!password) return null;

  const usernameLower = username?.trim().toLowerCase() || undefined;
  const result = normalizePassword(password, { usernameLower });

  return result.ok ? null : PASSWORD_ERROR_MESSAGES[result.error];
}

/** Whether a password would be accepted. Gates the sign-up button. */
export function isPasswordValid(password: string, username?: string): boolean {
  const usernameLower = username?.trim().toLowerCase() || undefined;
  return normalizePassword(password, { usernameLower }).ok;
}
