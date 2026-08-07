/**
 * The server half of password storage. Never imported by the frontend.
 *
 * Takes the key the browser already stretched (see ./password.ts, which *is*
 * shared) and runs PBKDF2 over it again with a random per-row salt. That second
 * pass adds little to an attacker's per-guess cost — the client's 600,000
 * iterations dominate — but it is what makes the stored value non-replayable:
 * a leaked table yields hashes, not credentials that can be posted straight
 * back to /api/auth/password/login.
 *
 * This is the one module in the codebase that is deliberately slow, which is
 * why lib/crypto.ts says everything *there* is not.
 */

import { CLIENT_KDF_VERSION } from "./password";
import { fromBase64Url, randomBytes, randomToken, timingSafeEqual, toBase64Url } from "./crypto";

/**
 * A self-imposed bound, not a platform one.
 *
 * cloudflare/workerd#1346 reports that crypto.subtle refuses PBKDF2 above
 * 100,000 iterations, throwing rather than clamping. That could not be
 * reproduced here — a local workerd happily ran 1,000,000 — so it is either
 * stale, or production-only, and there is no way to tell which from a test
 * suite. Staying underneath it costs nothing at the iteration count the CPU
 * budget allows anyway, so the assertion stands regardless of who is right.
 */
const PBKDF2_ITERATION_CEILING = 100_000;

/**
 * Server-side iterations.
 *
 * 20,000, and the number is measured rather than guessed: hashPassword at this
 * count averages 1.2ms in workerd, where 100,000 would be ~6ms and 600,000
 * ~37ms. The free plan allows 10ms per request in total, and the rest of a
 * login — JWT signing, three D1 round trips, JSON — has to fit in what is left.
 * Exceeding it is a hard 500 on the sign-in path, under load.
 *
 * Raising it also buys very little. The browser already carries 600,000, so
 * doubling this side moves an attacker's per-guess cost by well under a bit.
 *
 * Safe to raise later if that calculus changes: the value is recorded in every
 * stored hash, verification reads it from the row rather than from here, and a
 * successful login rehashes rows that have drifted.
 */
export const SERVER_ITERATIONS = 20_000;

if (SERVER_ITERATIONS >= PBKDF2_ITERATION_CEILING) {
  throw new Error(`SERVER_ITERATIONS must stay under ${PBKDF2_ITERATION_CEILING}`);
}

const SERVER_HASH = "SHA-256";
const SERVER_KDF_ID = "pbkdf2-sha256";
const SERVER_KEY_BYTES = 32;
const SERVER_SALT_BYTES = 16;

/** Version of the *encoding* below, so the parser itself can evolve. */
const FORMAT_VERSION = 1;

export interface StoredHash {
  /** Server-side PBKDF2 iterations used for this row. */
  iterations: number;
  /** Which client recipe produced the key that was fed in. 0 = none. */
  clientKdfVersion: number;
  salt: string;
  hash: string;
}

/**
 * PHC-shaped and self-describing:
 *
 *   $wtpw$v=1$pbkdf2-sha256$i=20000$c=1$<salt>$<hash>
 *
 * Every parameter travels with the value it produced, so verification never
 * reads a module constant and an upgrade never has to touch old rows.
 */
export function encodeStoredHash(parts: StoredHash): string {
  return [
    "",
    "wtpw",
    `v=${FORMAT_VERSION}`,
    SERVER_KDF_ID,
    `i=${parts.iterations}`,
    `c=${parts.clientKdfVersion}`,
    parts.salt,
    parts.hash,
  ].join("$");
}

/** Fails closed: anything unrecognised parses to null and verifies as false. */
export function parseStoredHash(value: string): StoredHash | null {
  const fields = value.split("$");
  if (fields.length !== 8) return null;

  const [leading, magic, version, kdf, iterations, client, salt, hash] = fields as [
    string, string, string, string, string, string, string, string,
  ];

  if (leading !== "" || magic !== "wtpw") return null;
  if (version !== `v=${FORMAT_VERSION}` || kdf !== SERVER_KDF_ID) return null;

  const iterationsMatch = /^i=(\d{1,7})$/.exec(iterations);
  const clientMatch = /^c=(\d{1,4})$/.exec(client);
  if (!iterationsMatch || !clientMatch) return null;
  if (!/^[A-Za-z0-9_-]+$/.test(salt) || !/^[A-Za-z0-9_-]+$/.test(hash)) return null;

  return {
    iterations: Number(iterationsMatch[1]),
    clientKdfVersion: Number(clientMatch[1]),
    salt,
    hash,
  };
}

async function deriveServerKey(
  clientKey: string,
  salt: string,
  iterations: number,
): Promise<string> {
  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(clientKey),
    "PBKDF2",
    false,
    ["deriveBits"],
  );

  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: fromBase64Url(salt), iterations, hash: SERVER_HASH },
    material,
    SERVER_KEY_BYTES * 8,
  );

  return toBase64Url(new Uint8Array(bits));
}

/** Hash a browser-derived key for storage, at current parameters. */
export async function hashPassword(
  clientKey: string,
  clientKdfVersion: number = CLIENT_KDF_VERSION,
): Promise<string> {
  const salt = toBase64Url(randomBytes(SERVER_SALT_BYTES));
  const hash = await deriveServerKey(clientKey, salt, SERVER_ITERATIONS);
  return encodeStoredHash({ iterations: SERVER_ITERATIONS, clientKdfVersion, salt, hash });
}

/**
 * Verify against the parameters recorded in the row, not the current ones.
 *
 * This is the property that makes SERVER_ITERATIONS safe to raise: rows written
 * under the old value keep verifying, and rehashOnLogin upgrades them one
 * successful sign-in at a time.
 */
export async function verifyPassword(clientKey: string, stored: string): Promise<boolean> {
  const parsed = parseStoredHash(stored);
  if (!parsed) return false;

  const candidate = await deriveServerKey(clientKey, parsed.salt, parsed.iterations);
  // Both sides are base64url of 32 bytes, so the length-mismatch early return
  // in timingSafeEqual is unreachable here and leaks nothing.
  return timingSafeEqual(candidate, parsed.hash);
}

/** True when a verified row was written under stale server parameters. */
export function needsRehash(stored: string): boolean {
  const parsed = parseStoredHash(stored);
  return parsed !== null && parsed.iterations !== SERVER_ITERATIONS;
}

let dummy: Promise<string> | null = null;

/**
 * A hash that nothing can match, for the user-not-found branch of login.
 *
 * Without it an unknown handle returns in well under a millisecond while a
 * wrong password takes a couple, which is a clean and trivially measurable
 * account-enumeration oracle. Verifying against this instead makes the two
 * paths cost the same.
 *
 * Built lazily from random bytes rather than hardcoded, so its iteration count
 * tracks SERVER_ITERATIONS automatically — a literal would silently stop
 * matching the timing of real rows the moment that constant moved. The promise
 * itself is cached so two concurrent misses derive it once.
 */
export function dummyStoredHash(): Promise<string> {
  dummy ??= hashPassword(randomToken(32));
  return dummy;
}
