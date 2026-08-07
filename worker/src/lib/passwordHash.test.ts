import { describe, expect, it } from "vitest";
import { deriveClientKey } from "./password";
import {
  SERVER_ITERATIONS,
  dummyStoredHash,
  encodeStoredHash,
  hashPassword,
  needsRehash,
  parseStoredHash,
  verifyPassword,
} from "./passwordHash";

/**
 * The server half: how a browser-derived key becomes a row, and how a row is
 * checked against one.
 *
 * The property that most needs pinning is that verification reads its
 * parameters out of the stored value rather than off a module constant. That is
 * what makes SERVER_ITERATIONS safe to change later — get it wrong and raising
 * the constant silently locks out every existing account at once.
 */

const clientKey = (password: string, username = "alice") =>
  deriveClientKey(password, username, { iterations: 1_000 });

describe("encodeStoredHash / parseStoredHash", () => {
  it("round-trips", () => {
    const parts = { iterations: 20_000, clientKdfVersion: 1, salt: "c2FsdA", hash: "aGFzaA" };
    const parsed = parseStoredHash(encodeStoredHash(parts));
    expect(parsed).toEqual(parts);
  });

  it("produces the documented shape", async () => {
    const stored = await hashPassword(await clientKey("orbital-teapot-42"));
    expect(stored).toMatch(
      new RegExp(`^\\$wtpw\\$v=1\\$pbkdf2-sha256\\$i=${SERVER_ITERATIONS}\\$c=1\\$[\\w-]+\\$[\\w-]+$`),
    );
  });

  it.each([
    ["empty", ""],
    ["not ours", "$argon2id$v=19$m=65536,t=3,p=4$c2FsdA$aGFzaA"],
    ["wrong magic", "$wtpw2$v=1$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA"],
    ["unknown format version", "$wtpw$v=2$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA"],
    ["unknown kdf", "$wtpw$v=1$scrypt$i=20000$c=1$c2FsdA$aGFzaA"],
    ["too few fields", "$wtpw$v=1$pbkdf2-sha256$i=20000$c2FsdA$aGFzaA"],
    ["too many fields", "$wtpw$v=1$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA$extra"],
    ["non-numeric iterations", "$wtpw$v=1$pbkdf2-sha256$i=lots$c=1$c2FsdA$aGFzaA"],
    ["missing leading separator", "wtpw$v=1$pbkdf2-sha256$i=20000$c=1$c2FsdA$aGFzaA"],
    ["salt outside base64url", "$wtpw$v=1$pbkdf2-sha256$i=20000$c=1$c2Fs+dA$aGFzaA"],
  ])("fails closed on a stored value that is %s", (_label, value) => {
    expect(parseStoredHash(value)).toBeNull();
  });

  it("verifies nothing against an unparseable row", async () => {
    expect(await verifyPassword(await clientKey("orbital-teapot-42"), "garbage")).toBe(false);
  });
});

describe("hashPassword / verifyPassword", () => {
  it("accepts the key it was built from", async () => {
    const key = await clientKey("orbital-teapot-42");
    expect(await verifyPassword(key, await hashPassword(key))).toBe(true);
  });

  it("rejects a different key", async () => {
    const stored = await hashPassword(await clientKey("orbital-teapot-42"));
    expect(await verifyPassword(await clientKey("orbital-teapot-43"), stored)).toBe(false);
  });

  it("rejects the same password derived under a different username", async () => {
    // The client salt is the username, so this is a different credential even
    // though the human typed the same thing.
    const stored = await hashPassword(await clientKey("orbital-teapot-42", "alice"));
    expect(await verifyPassword(await clientKey("orbital-teapot-42", "bob"), stored)).toBe(false);
  });

  it("salts every row separately", async () => {
    const key = await clientKey("orbital-teapot-42");
    const [first, second] = [await hashPassword(key), await hashPassword(key)];

    expect(first).not.toBe(second);
    // ...and both still verify, which is what says the difference is the salt
    // and not something worse.
    expect(await verifyPassword(key, first)).toBe(true);
    expect(await verifyPassword(key, second)).toBe(true);
  });

  it("records the client recipe that produced the key", async () => {
    const stored = await hashPassword(await clientKey("orbital-teapot-42"), 1);
    expect(parseStoredHash(stored)?.clientKdfVersion).toBe(1);
  });
});

describe("parameter upgrades", () => {
  /**
   * The load-bearing test. A row written at 1,000 iterations must keep
   * verifying after SERVER_ITERATIONS moves to 20,000 — if verification ever
   * re-derives at the current constant instead of the row's own value, raising
   * that constant locks every existing user out simultaneously.
   */
  it("verifies a row against the iteration count stored in it, not the current one", async () => {
    const key = await clientKey("orbital-teapot-42");

    // Hand-build a row at parameters that are deliberately not the current ones.
    const legacyIterations = 1_000;
    expect(legacyIterations).not.toBe(SERVER_ITERATIONS);

    const salt = "c2FsdHlzYWx0eXNhbHQ";
    const material = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(key),
      "PBKDF2",
      false,
      ["deriveBits"],
    );
    const bits = await crypto.subtle.deriveBits(
      {
        name: "PBKDF2",
        salt: Uint8Array.from(atob(salt.replace(/-/g, "+").replace(/_/g, "/") + "="), (ch) =>
          ch.charCodeAt(0),
        ),
        iterations: legacyIterations,
        hash: "SHA-256",
      },
      material,
      256,
    );
    const hash = btoa(String.fromCharCode(...new Uint8Array(bits)))
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    const legacy = encodeStoredHash({
      iterations: legacyIterations,
      clientKdfVersion: 1,
      salt,
      hash,
    });

    expect(await verifyPassword(key, legacy)).toBe(true);
    expect(needsRehash(legacy)).toBe(true);
  });

  it("does not ask to rehash a row already at current parameters", async () => {
    const stored = await hashPassword(await clientKey("orbital-teapot-42"));
    expect(needsRehash(stored)).toBe(false);
  });

  it("does not ask to rehash something it cannot read", async () => {
    // verifyPassword has already returned false by then; claiming otherwise
    // would send the login path off to rehash a row it never authenticated.
    expect(needsRehash("garbage")).toBe(false);
  });
});

describe("dummyStoredHash", () => {
  it("is a well-formed row that nothing verifies against", async () => {
    const dummy = await dummyStoredHash();
    expect(parseStoredHash(dummy)).not.toBeNull();
    expect(await verifyPassword(await clientKey("orbital-teapot-42"), dummy)).toBe(false);
  });

  it("is built once and reused", async () => {
    expect(await dummyStoredHash()).toBe(await dummyStoredHash());
  });

  it("tracks the current iteration count, so its timing matches a real row", async () => {
    // A hardcoded literal would have silently stopped matching real rows the
    // moment SERVER_ITERATIONS moved, quietly reopening the timing oracle this
    // whole mechanism exists to close.
    expect(parseStoredHash(await dummyStoredHash())?.iterations).toBe(SERVER_ITERATIONS);
  });
});

describe("CPU budget", () => {
  /**
   * The guard on the entire KDF decision. Every password sign-in runs one of
   * these inside a 10ms free-plan budget that also pays for JWT signing, three
   * D1 round trips and JSON. If this goes red, logins are about to start
   * returning 500 in production rather than merely getting slower.
   *
   * Wall clock over-reports what Cloudflare bills, so passing here is necessary
   * and not sufficient — the authoritative number comes from the dashboard.
   */
  it("hashes well inside the 10ms free-plan ceiling", async () => {
    const key = await clientKey("orbital-teapot-42");

    const started = Date.now();
    const stored = await hashPassword(key);
    const elapsed = Date.now() - started;

    expect(stored).toBeTruthy();
    console.log(`hashPassword at i=${SERVER_ITERATIONS} wall clock: ${elapsed}ms`);
    expect(elapsed).toBeLessThan(5);
  });
});
