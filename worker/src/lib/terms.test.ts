import { describe, expect, it } from "vitest";
import { TERMS_VERSION, hasAcceptedCurrentTerms } from "./terms";

/**
 * The version comparison is the whole point of this function, so that is what
 * is worth pinning. /me and every login response answer "has this user
 * accepted?" from here; answering it from `accepted_terms_at` alone — which
 * they used to — silently made a TERMS_VERSION bump a no-op for everyone who
 * had ever accepted anything.
 */
describe("hasAcceptedCurrentTerms", () => {
  it("accepts a user who agreed to the version in force", () => {
    expect(
      hasAcceptedCurrentTerms({ accepted_terms_at: 1_700_000_000_000, terms_version: TERMS_VERSION }),
    ).toBe(true);
  });

  it("re-prompts a user who agreed to an older version", () => {
    // The regression this function exists for. A timestamp is present and the
    // old check would have called this accepted.
    expect(
      hasAcceptedCurrentTerms({ accepted_terms_at: 1_700_000_000_000, terms_version: "0.9" }),
    ).toBe(false);
  });

  it("re-prompts a user who has never accepted", () => {
    expect(hasAcceptedCurrentTerms({ accepted_terms_at: null, terms_version: null })).toBe(false);
  });

  it("re-prompts when the timestamp is there but the version is not", () => {
    // Only reachable from rows written before terms_version existed. Falling to
    // false costs one extra prompt; falling to true would skip the gate for
    // exactly the users whose acceptance cannot be identified.
    expect(
      hasAcceptedCurrentTerms({ accepted_terms_at: 1_700_000_000_000, terms_version: null }),
    ).toBe(false);
  });

  it("does not treat a version recorded ahead of the current one as current", () => {
    // A rollback puts the deployed version behind what some rows already hold.
    // Equality, not ordering: those users see the gate again, which is correct,
    // because the text they are being held to is the text now being served.
    expect(
      hasAcceptedCurrentTerms({ accepted_terms_at: 1_700_000_000_000, terms_version: "99.0" }),
    ).toBe(false);
  });
});
