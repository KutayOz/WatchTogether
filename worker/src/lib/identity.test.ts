import { describe, expect, it } from "vitest";
import {
  DISCRIMINATOR_MAX,
  DISCRIMINATOR_MIN,
  formatTag,
  newDiscriminator,
  normalizeUsername,
  parseTag,
} from "./identity";

describe("newDiscriminator", () => {
  it("always produces four digits in range", () => {
    for (let i = 0; i < 20_000; i++) {
      const d = newDiscriminator();
      expect(d).toMatch(/^\d{4}$/);
      const n = Number(d);
      expect(n).toBeGreaterThanOrEqual(DISCRIMINATOR_MIN);
      expect(n).toBeLessThanOrEqual(DISCRIMINATOR_MAX);
    }
  });

  it("is uniform — no modulo bias toward low values", () => {
    // 9999 does not divide 65536, so a naive `random % 9999` would over-favour
    // the low residues. Rejection sampling should leave every bucket flat.
    const DRAWS = 1_000_000;
    const BUCKETS = 10;
    const bucketSize = DISCRIMINATOR_MAX / BUCKETS;
    const counts = new Array<number>(BUCKETS).fill(0);

    for (let i = 0; i < DRAWS; i++) {
      const n = Number(newDiscriminator()) - DISCRIMINATOR_MIN;
      counts[Math.min(BUCKETS - 1, Math.floor(n / bucketSize))]!++;
    }

    const expected = DRAWS / BUCKETS;
    for (const count of counts) {
      // Chance of a legitimate 2% deviation at n=100k per bucket is negligible.
      expect(Math.abs(count - expected) / expected).toBeLessThan(0.02);
    }
  });
});

describe("normalizeUsername", () => {
  it("accepts ordinary names and preserves typed case", () => {
    const result = normalizeUsername("  Kutay_Oz.1  ");
    expect(result).toEqual({
      ok: true,
      value: { username: "Kutay_Oz.1", usernameLower: "kutay_oz.1" },
    });
  });

  it.each([
    ["ab", "too_short"],
    ["a".repeat(21), "too_long"],
    ["kutay oz", "invalid_characters"],
    ["kutay-oz", "invalid_characters"],
    ["admin", "reserved"],
    ["ROOT", "reserved"],
  ])("rejects %s", (input, error) => {
    expect(normalizeUsername(input)).toEqual({ ok: false, error });
  });

  it("rejects non-ASCII lookalikes that could impersonate another user", () => {
    // Cyrillic 'а' (U+0430) renders identically to Latin 'a'.
    expect(normalizeUsername("pаypal")).toEqual({ ok: false, error: "invalid_characters" });
  });

  it("lowercases locale-independently", () => {
    // Under a Turkish locale toLocaleLowerCase maps 'I' to a dotless 'ı', so
    // the same name would normalize differently depending on where the Worker
    // ran. toLowerCase must always yield ASCII 'i'.
    const result = normalizeUsername("KUTAYIZ");
    expect(result.ok && result.value.usernameLower).toBe("kutayiz");
  });

  it("collapses NFKC-equivalent compositions to one form", () => {
    // U+FF21 FULLWIDTH LATIN CAPITAL A normalizes to plain 'A'.
    const result = normalizeUsername("Ａbc");
    expect(result.ok && result.value.username).toBe("Abc");
  });
});

describe("tag formatting", () => {
  it("round-trips", () => {
    expect(parseTag(formatTag("alice", "0042"))).toEqual({
      username: "alice",
      discriminator: "0042",
    });
  });

  it("splits on the last hash, so a name may not swallow the discriminator", () => {
    expect(parseTag("a#b#1234")).toEqual({ username: "a#b", discriminator: "1234" });
  });

  it.each(["alice", "alice#12", "alice#abcd", "#1234", "alice#12345"])(
    "rejects malformed tag %s",
    (tag) => {
      expect(parseTag(tag)).toBeNull();
    },
  );
});
