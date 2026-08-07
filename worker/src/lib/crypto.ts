/**
 * Encoding and hashing helpers.
 *
 * Everything here is WebCrypto or pure arithmetic, and nothing here is
 * deliberately slow. The Workers free plan allows 10ms of CPU per invocation,
 * which is why BCrypt (work factor 12, ~400ms) could not come across from the
 * .NET backend.
 *
 * The one place in the codebase that *is* deliberately slow is
 * ./passwordHash.ts, which spends ~1.2ms on PBKDF2. It can afford that only
 * because the expensive half of the work happens in the browser — see
 * ./password.ts. Do not add a slow primitive here.
 */

export function toBase64Url(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/**
 * Return types are pinned to `Uint8Array<ArrayBuffer>` rather than the default
 * `ArrayBufferLike`. Since TypeScript 5.7 typed arrays are generic over their
 * backing buffer, and WebAuthn APIs require the non-shared variant.
 */
export function fromBase64Url(value: string): Uint8Array<ArrayBuffer> {
  const padded = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(padded.padEnd(Math.ceil(padded.length / 4) * 4, "="));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export function randomBytes(length: number): Uint8Array<ArrayBuffer> {
  return crypto.getRandomValues(new Uint8Array(length));
}

/** base64url of `length` random bytes. Used for user handles and raw tokens. */
export function randomToken(length = 32): string {
  return toBase64Url(randomBytes(length));
}

/**
 * Lowercase hex SHA-256. This is the invite-token lookup key: tokens are stored
 * only as their hash, and the raw token exists solely in the URL handed to the
 * invitee.
 */
export async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-invariant string comparison, for anything compared against a secret.
 * Returns early on length mismatch — lengths are not secret here, contents are.
 */
export function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
