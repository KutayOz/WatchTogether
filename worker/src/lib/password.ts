/**
 * Passwords — the half the browser and the Worker have to agree on.
 *
 * Imported by the frontend as `@shared/password`, so keep it small and free of
 * anything Worker-shaped. The server-only half (hashing, storage encoding,
 * verification) lives in ./passwordHash.ts and must never be imported by the
 * frontend.
 *
 * ## Why the browser does most of the work
 *
 * bcrypt, scrypt and argon2 do not exist on Workers, so PBKDF2 via crypto.subtle
 * is the only option. OWASP asks for 600,000 iterations of it. Measured in
 * workerd, 600,000 costs ~37ms of pure compute — against a free-plan budget of
 * 10ms per request that also has to pay for JWT signing, three D1 round trips
 * and JSON. Server-side stretching cannot reach current guidance here, and
 * overshooting is not a slow login but a hard 500 on the sign-in path.
 *
 * The work is therefore split: the browser derives a key from the password at
 * 600,000 iterations and sends *that*, and the Worker runs 20,000 more over a
 * random per-row salt before storing anything. An attacker holding the table
 * pays both halves, ~620,000 per guess. The Worker pays ~1.2ms.
 *
 * ## Two rules that are not obvious
 *
 * 1. `iterations` on the *server* side is upgradable in place; the *client*
 *    recipe is effectively frozen. At login the browser has to derive before
 *    the server has said anything, so it cannot know which recipe the stored
 *    row used — bumping CLIENT_KDF_VERSION would strand every existing row.
 *    The version is carried in the stored hash anyway (`c=`), so a future
 *    migration could identify which rows need which treatment, but the escape
 *    hatch is a client that sends derivations under every supported version.
 *    Adding to CLIENT_KDF_PARAMS is safe; changing entry 1 is not.
 *
 * 2. Everything in this file is advice the client is trusted to take. The
 *    server receives 32 derived bytes and cannot check length, or a blocklist,
 *    or anything else here. That is a real limitation and worth being precise
 *    about: unlike username rules — where a lax client lets someone
 *    impersonate a *third party* — a bypassed password rule weakens exactly
 *    one account, the attacker's own. What the server does enforce is the
 *    shape of the credential and that the declared recipe is one it knows.
 */

import { toBase64Url } from "./crypto";

export const PASSWORD_MIN_LENGTH = 12;
/**
 * Not a DoS concern — PBKDF2 folds the input into an HMAC key once, so cost is
 * length-independent. This is about bounding what gets imported as key material
 * and not storing unbounded user input. Above every password manager's default.
 */
export const PASSWORD_MAX_LENGTH = 128;

/** base64url of 32 bytes, unpadded. The only shape the server will accept. */
export const CLIENT_KEY_LENGTH = 43;
export const CLIENT_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/**
 * The frozen table of client recipes. Add entries; never edit one.
 *
 * `0` is reserved and deliberately absent: it means "no client stretch" in the
 * stored encoding, which is how a server-only hash would be recorded if that
 * decision is ever revisited.
 */
export const CLIENT_KDF_PARAMS = {
  1: { iterations: 600_000, hash: "SHA-256", keyBytes: 32 },
} as const;

export type ClientKdfVersion = keyof typeof CLIENT_KDF_PARAMS;

export const CLIENT_KDF_VERSION: ClientKdfVersion = 1;

export function isClientKdfVersion(value: unknown): value is ClientKdfVersion {
  return typeof value === "number" && Object.hasOwn(CLIENT_KDF_PARAMS, value);
}

export type PasswordError =
  | "too_short"
  | "too_long"
  | "whitespace_only"
  | "contains_username"
  | "too_common";

/**
 * Common passwords that survive the length rule.
 *
 * Every entry is at least PASSWORD_MIN_LENGTH characters, because anything
 * shorter is already rejected and would be dead weight. Deliberately small:
 * zxcvbn's dictionaries were 1.2MB and 465kB, they left with the .NET backend,
 * and frontend/vite.config.ts names them as the reason the chunk-size warning
 * limit exists. This ships in the browser bundle.
 */
const COMMON_PASSWORDS = new Set([
  "000000000000",
  "111111111111",
  "121212121212",
  "123123123123",
  "123456789012",
  "1234567890123",
  "1234qwerasdf",
  "1qaz2wsx3edc",
  "aaaaaaaaaaaa",
  "abc123abc123",
  "abcd1234abcd",
  "abcdefghijkl",
  "admin123456789",
  "administrator",
  "arsenal12345",
  "asdfghjkl123",
  "baseball1234",
  "basketball12",
  "batman123456",
  "changeme1234",
  "cheese123456",
  "chocolate123",
  "computer1234",
  "correcthorse",
  "dragon123456",
  "facebook1234",
  "football1234",
  "freedom12345",
  "google123456",
  "hello1234567",
  "iloveyou1234",
  "instagram123",
  "iphone123456",
  "jennifer1234",
  "letmein12345",
  "liverpool123",
  "loveyou12345",
  "manchester12",
  "master123456",
  "michael12345",
  "monkey123456",
  "nintendo1234",
  "passw0rd1234",
  "password1234",
  "passwordpassword",
  "pokemon12345",
  "princess1234",
  "qazwsxedcrfv",
  "qwertyuiop12",
  "qwertyuiop123",
  "qwertyuiopas",
  "samsung12345",
  "secret123456",
  "shadow123456",
  "starwars1234",
  "sunshine1234",
  "superman1234",
  "temppassword",
  "trustno1trustno1",
  "watchtogether",
  "welcome12345",
  "whatever1234",
  "zxcvbnm12345",
]);

export interface NormalizedPassword {
  /** NFKC-normalized, never trimmed. This exact string is what gets derived. */
  password: string;
}

/**
 * Validate and normalize a chosen password.
 *
 * NFKC, matching normalizeUsername, and for a harder reason than tidiness: the
 * *client* derives the key, so if the two sides disagreed about normalization
 * the resulting login failure would be unfixable — there is no plaintext on the
 * server to re-derive from.
 *
 * Not trimmed, deliberately. Silently altering someone's password is worse than
 * rejecting it, so leading and trailing spaces are kept and an all-whitespace
 * password is refused outright.
 *
 * No composition rules. NIST SP 800-63B deprecates them; "must contain a digit
 * and a symbol" reliably produces `Password1!`, which is worse than a
 * fourteen-character phrase. Length is the only lever that buys real entropy.
 */
export function normalizePassword(
  raw: string,
  context: { usernameLower?: string } = {},
): { ok: true; value: NormalizedPassword } | { ok: false; error: PasswordError } {
  const password = raw.normalize("NFKC");

  if (password.trim().length === 0) return { ok: false, error: "whitespace_only" };
  if (password.length < PASSWORD_MIN_LENGTH) return { ok: false, error: "too_short" };
  if (password.length > PASSWORD_MAX_LENGTH) return { ok: false, error: "too_long" };

  // toLowerCase, never toLocaleLowerCase — same reasoning as identity.ts.
  const lower = password.toLowerCase();
  const usernameLower = context.usernameLower?.normalize("NFKC").toLowerCase();

  if (usernameLower && (lower.includes(usernameLower) || usernameLower.includes(lower))) {
    return { ok: false, error: "contains_username" };
  }

  if (COMMON_PASSWORDS.has(lower)) return { ok: false, error: "too_common" };

  return { ok: true, value: { password } };
}

/**
 * The client-side salt, derived rather than fetched.
 *
 * Fetching a per-user salt before login would be an account-existence oracle;
 * deriving it costs nothing and leaks nothing. Two users named `alice` share a
 * salt, and that is fine — this salt's only job is domain separation against
 * precomputed tables, cross-user and cross-application. Per-row uniqueness is
 * the *server* salt's job, and that is 16 random bytes.
 *
 * Keyed on the username rather than the full tag because at signup the
 * discriminator does not exist yet: createUser allocates it by random draw
 * against uniq_users_tag, server-side, after this has already run.
 */
export function clientSaltFor(usernameLower: string): string {
  return `watchtogether:pwd:v1:${usernameLower}`;
}

/**
 * Stretch a password into the credential the wire actually carries.
 *
 * `iterations` exists to be overridden by tests and nothing else. A real
 * derivation costs ~37ms, and a suite that signs in dozens of times would spend
 * most of its runtime on arithmetic it is not testing; the worker tests derive
 * at a low count and still declare version 1. That is sound rather than a
 * cheat, because the count is a claim the server never verifies — see the
 * header. Production callers must not pass it.
 */
export async function deriveClientKey(
  password: string,
  usernameLower: string,
  options: { version?: ClientKdfVersion; iterations?: number } = {},
): Promise<string> {
  const version = options.version ?? CLIENT_KDF_VERSION;
  const params = CLIENT_KDF_PARAMS[version];
  if (!params) throw new Error(`Unknown client KDF version: ${String(version)}`);

  const encoder = new TextEncoder();
  const material = await crypto.subtle.importKey(
    "raw",
    encoder.encode(password.normalize("NFKC")),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    {
      name: "PBKDF2",
      salt: encoder.encode(clientSaltFor(usernameLower)),
      iterations: options.iterations ?? params.iterations,
      hash: params.hash,
    },
    material,
    params.keyBytes * 8,
  );

  return toBase64Url(new Uint8Array(bits));
}

export const PASSWORD_ERROR_MESSAGES: Record<PasswordError, string> = {
  too_short: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
  too_long: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
  whitespace_only: "Password cannot be only spaces.",
  contains_username: "Password must not contain your username.",
  too_common: "That password is too common. Pick something harder to guess.",
};
