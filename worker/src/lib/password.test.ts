import { describe, expect, it } from "vitest";
import {
  CLIENT_KDF_VERSION,
  CLIENT_KEY_PATTERN,
  PASSWORD_ERROR_MESSAGES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  clientSaltFor,
  deriveClientKey,
  isClientKdfVersion,
  normalizePassword,
  type PasswordError,
} from "./password";

/**
 * The shared half of the password design — the rules and the derivation both
 * the browser and the Worker have to agree on.
 *
 * Worth stating what these tests are *not*: they are not a security boundary.
 * normalizePassword runs in the browser and nowhere else, because the server
 * only ever receives a derived key. What is pinned here is that the rules are
 * consistent and that the derivation is deterministic — the second of which is
 * load-bearing in a way the first is not, since a client and a server that
 * disagree about normalization produce a login failure with no plaintext left
 * anywhere to debug it from.
 */

/** Long enough to clear the length rule without tripping the blocklist. */
const GOOD = "orbital-teapot-42";

describe("normalizePassword", () => {
  it("accepts an ordinary long password unchanged", () => {
    const result = normalizePassword(GOOD);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.password).toBe(GOOD);
  });

  it.each<[string, string, PasswordError]>([
    ["under the minimum", "a".repeat(PASSWORD_MIN_LENGTH - 1), "too_short"],
    ["over the maximum", "a".repeat(PASSWORD_MAX_LENGTH + 1), "too_long"],
    ["only spaces", "               ", "whitespace_only"],
    ["only tabs and newlines", "\t\t\n\n\t\t\n\n\t\t\n\n", "whitespace_only"],
    ["a common password", "password1234", "too_common"],
    ["a common password in caps", "PASSWORD1234", "too_common"],
  ])("rejects %s", (_label, password, error) => {
    const result = normalizePassword(password);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(error);
  });

  it("accepts exactly the minimum and maximum lengths", () => {
    expect(normalizePassword("q".repeat(PASSWORD_MIN_LENGTH)).ok).toBe(true);
    expect(normalizePassword("q".repeat(PASSWORD_MAX_LENGTH)).ok).toBe(true);
  });

  it("keeps leading and trailing spaces rather than trimming them away", () => {
    // Silently altering a password is worse than rejecting one: the browser
    // derives from this exact string, so a trim here would be a login failure
    // later with nothing left to compare against.
    const padded = `  ${GOOD}  `;
    const result = normalizePassword(padded);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.password).toBe(padded);
  });

  it("collapses NFKC-equivalent spellings to one string", () => {
    // e + combining acute vs. precomposed é. If these two normalized
    // differently, the same typed password would derive two different keys.
    const decomposed = normalizePassword("café-orbital-teapot");
    const precomposed = normalizePassword("café-orbital-teapot");
    expect(decomposed.ok && precomposed.ok).toBe(true);
    if (!decomposed.ok || !precomposed.ok) return;
    expect(decomposed.value.password).toBe(precomposed.value.password);
  });

  it("rejects a password containing the username, in either direction", () => {
    expect(normalizePassword("alice-alice-alice", { usernameLower: "alice" })).toMatchObject({
      ok: false,
      error: "contains_username",
    });
    // And the reverse: a password that is a substring of a long username.
    expect(
      normalizePassword("bartholomew12", { usernameLower: "bartholomew123456" }),
    ).toMatchObject({ ok: false, error: "contains_username" });
  });

  it("matches the username case-insensitively", () => {
    expect(normalizePassword("ALICE-in-wonderland", { usernameLower: "alice" })).toMatchObject({
      ok: false,
      error: "contains_username",
    });
  });

  it("ignores the username rule when no username is supplied", () => {
    expect(normalizePassword("alice-alice-alice").ok).toBe(true);
  });

  it("has a message for every error, and none of them are empty", () => {
    for (const [error, message] of Object.entries(PASSWORD_ERROR_MESSAGES)) {
      expect(message.length, error).toBeGreaterThan(0);
    }
  });
});

describe("clientSaltFor", () => {
  it("is deterministic", () => {
    expect(clientSaltFor("alice")).toBe(clientSaltFor("alice"));
  });

  it("separates users, and separates this application from every other one", () => {
    expect(clientSaltFor("alice")).not.toBe(clientSaltFor("bob"));
    // The prefix is the whole point: without it, a password reused on another
    // site that salted by bare username would derive the same key here.
    expect(clientSaltFor("alice")).toContain("watchtogether");
    expect(clientSaltFor("alice")).not.toBe("alice");
  });
});

describe("isClientKdfVersion", () => {
  it("accepts the current version and rejects everything else", () => {
    expect(isClientKdfVersion(CLIENT_KDF_VERSION)).toBe(true);
    // 0 is reserved in the stored encoding for "no client stretch" and must
    // never be accepted off the wire as a recipe.
    expect(isClientKdfVersion(0)).toBe(false);
    expect(isClientKdfVersion(2)).toBe(false);
    expect(isClientKdfVersion("1")).toBe(false);
    expect(isClientKdfVersion(null)).toBe(false);
    expect(isClientKdfVersion(undefined)).toBe(false);
  });
});

/**
 * These derive at a low iteration count. Nothing forces that — workerd runs the
 * production 600,000 fine — it is only that a real derivation costs ~37ms and
 * these tests are about determinism, not arithmetic. The cost of the real
 * recipe is pinned once, below.
 */
describe("deriveClientKey", () => {
  const iterations = 1_000;

  it("produces the wire shape the server will accept", async () => {
    const key = await deriveClientKey(GOOD, "alice", { iterations });
    expect(key).toMatch(CLIENT_KEY_PATTERN);
    expect(key).toHaveLength(43);
  });

  it("is deterministic for the same password and username", async () => {
    const a = await deriveClientKey(GOOD, "alice", { iterations });
    const b = await deriveClientKey(GOOD, "alice", { iterations });
    expect(a).toBe(b);
  });

  it("gives two users with the same password different keys", async () => {
    const alice = await deriveClientKey(GOOD, "alice", { iterations });
    const bob = await deriveClientKey(GOOD, "bob", { iterations });
    expect(alice).not.toBe(bob);
  });

  it("gives two passwords under one username different keys", async () => {
    const one = await deriveClientKey(GOOD, "alice", { iterations });
    const two = await deriveClientKey(`${GOOD}!`, "alice", { iterations });
    expect(one).not.toBe(two);
  });

  it("derives NFKC-equivalent passwords to the same key", async () => {
    const decomposed = await deriveClientKey("café-orbital", "alice", { iterations });
    const precomposed = await deriveClientKey("café-orbital", "alice", { iterations });
    expect(decomposed).toBe(precomposed);
  });

  it("refuses an unknown recipe rather than silently picking one", async () => {
    await expect(
      deriveClientKey(GOOD, "alice", { version: 99 as never, iterations }),
    ).rejects.toThrow(/Unknown client KDF version/);
  });

  it("runs the real 600,000-iteration recipe, and it is not cheap", async () => {
    // cloudflare/workerd#1346 says crypto.subtle refuses PBKDF2 above 100,000.
    // It does not, here — which is exactly why passwordHash.ts treats that cap
    // as self-imposed rather than as a platform fact it can rely on.
    const started = Date.now();
    const key = await deriveClientKey(GOOD, "alice");
    const elapsed = Date.now() - started;

    expect(key).toMatch(CLIENT_KEY_PATTERN);
    // The cost is the point of the design: this is work a browser can afford
    // and a Worker on a 10ms budget cannot, which is why it happens over there.
    // Loose bound — CI hardware varies — but it must not silently become free.
    expect(elapsed).toBeGreaterThan(5);
  });
});
