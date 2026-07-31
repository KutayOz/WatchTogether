/**
 * Discord-style identity: `username#1234`.
 *
 * The username is chosen, the four-digit discriminator is allocated by the
 * server. Neither is unique alone; the pair is, enforced by the
 * uniq_users_tag index rather than by any application-level locking.
 */

export const DISCRIMINATOR_MIN = 1;
export const DISCRIMINATOR_MAX = 9999;
/** Reserved for the root user so the first account is always `name#0000`. */
export const ROOT_DISCRIMINATOR = "0000";

export const USERNAME_MIN_LENGTH = 3;
export const USERNAME_MAX_LENGTH = 20;

/**
 * ASCII letters, digits, underscore and dot only.
 *
 * Deliberately narrow: allowing Unicode would let `paypaI` (capital i) or a
 * Cyrillic `а` impersonate another user, and a two-person video app gains
 * nothing from emoji usernames.
 */
const USERNAME_PATTERN = /^[a-zA-Z0-9_.]+$/;

/**
 * Largest multiple of the discriminator range that fits in a Uint16.
 *
 * 9999 does not divide 65536 evenly, so `random % 9999` alone would make the
 * low residues fractionally more likely. Rejecting draws at or above this
 * bound makes every residue equally probable. 9999 * 6 = 59994.
 */
const REJECTION_BOUND = 65536 - (65536 % DISCRIMINATOR_MAX);

export type UsernameError =
  | "too_short"
  | "too_long"
  | "invalid_characters"
  | "reserved";

/** Names that would be confusing or misleading as a user identity. */
const RESERVED_USERNAMES = new Set([
  "admin",
  "root",
  "system",
  "watchtogether",
  "moderator",
  "support",
  "deleted",
]);

export interface NormalizedUsername {
  /** As the user typed it, after trimming and Unicode normalization. */
  username: string;
  /** Lowercase form used for the uniqueness constraint. */
  usernameLower: string;
}

/**
 * Validate and normalize a chosen username.
 *
 * NFKC first, so visually identical compositions collapse to one form before
 * the ASCII check rejects anything that survived as non-ASCII.
 */
export function normalizeUsername(
  raw: string,
): { ok: true; value: NormalizedUsername } | { ok: false; error: UsernameError } {
  const username = raw.trim().normalize("NFKC");

  if (username.length < USERNAME_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (username.length > USERNAME_MAX_LENGTH) return { ok: false, error: "too_long" };
  if (!USERNAME_PATTERN.test(username)) return { ok: false, error: "invalid_characters" };

  // toLowerCase, never toLocaleLowerCase: the latter maps a dotted capital I to
  // a dotless one under a Turkish locale, so the same name could normalize two
  // different ways depending on where the Worker happened to run.
  const usernameLower = username.toLowerCase();

  if (RESERVED_USERNAMES.has(usernameLower)) return { ok: false, error: "reserved" };

  return { ok: true, value: { username, usernameLower } };
}

/**
 * Draw a uniformly random discriminator in 0001..9999.
 *
 * Collisions are not checked here — the caller inserts with
 * `ON CONFLICT DO NOTHING` and redraws if the insert affected no rows. That
 * keeps allocation to a single round trip in the common case and needs no
 * counter table or lock.
 */
export function newDiscriminator(): string {
  const buffer = new Uint16Array(1);
  do {
    crypto.getRandomValues(buffer);
  } while (buffer[0]! >= REJECTION_BOUND);
  return String((buffer[0]! % DISCRIMINATOR_MAX) + DISCRIMINATOR_MIN).padStart(4, "0");
}

/** `alice` + `0042` -> `alice#0042`. */
export function formatTag(username: string, discriminator: string): string {
  return `${username}#${discriminator}`;
}

/** `alice#0042` -> `{ username: 'alice', discriminator: '0042' }`. */
export function parseTag(tag: string): { username: string; discriminator: string } | null {
  const hash = tag.lastIndexOf("#");
  if (hash <= 0) return null;

  const username = tag.slice(0, hash);
  const discriminator = tag.slice(hash + 1);
  if (!/^\d{4}$/.test(discriminator)) return null;

  return { username, discriminator };
}

export const USERNAME_ERROR_MESSAGES: Record<UsernameError, string> = {
  too_short: `Username must be at least ${USERNAME_MIN_LENGTH} characters.`,
  too_long: `Username must be at most ${USERNAME_MAX_LENGTH} characters.`,
  invalid_characters: "Username may only contain letters, numbers, underscores and dots.",
  reserved: "That username is reserved.",
};
