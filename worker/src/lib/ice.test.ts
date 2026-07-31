import { describe, expect, it } from "vitest";
import { normalizeEntries } from "./ice";

/**
 * These shapes are not hypothetical. The first deployment against a live
 * Cloudflare TURN key parsed the response as a single object, got nothing, and
 * silently served STUN only — which is indistinguishable from working until
 * somebody behind symmetric NAT cannot connect.
 */
describe("Cloudflare ICE response shapes", () => {
  const credentials = { username: "user", credential: "pass" };

  it("handles iceServers as an array of entries", () => {
    const servers = normalizeEntries({
      iceServers: [{ urls: ["turn:a.example:3478", "turns:a.example:5349"], ...credentials }],
    });

    expect(servers).toEqual([
      { urls: "turn:a.example:3478", ...credentials },
      { urls: "turns:a.example:5349", ...credentials },
    ]);
  });

  it("handles iceServers as a single object", () => {
    const servers = normalizeEntries({
      iceServers: { urls: ["turn:b.example:3478"], ...credentials },
    });

    expect(servers).toEqual([{ urls: "turn:b.example:3478", ...credentials }]);
  });

  it("handles urls as a bare string rather than an array", () => {
    const servers = normalizeEntries({
      iceServers: { urls: "turn:c.example:3478", ...credentials },
    });

    expect(servers).toEqual([{ urls: "turn:c.example:3478", ...credentials }]);
  });

  it("flattens several entries, keeping each entry's own credentials", () => {
    const servers = normalizeEntries({
      iceServers: [
        { urls: ["turn:a.example:3478"], username: "u1", credential: "c1" },
        { urls: ["turn:b.example:3478"], username: "u2", credential: "c2" },
      ],
    });

    expect(servers).toHaveLength(2);
    expect(servers[0]).toMatchObject({ username: "u1" });
    expect(servers[1]).toMatchObject({ username: "u2" });
  });

  it.each([
    ["missing iceServers", {}],
    ["empty array", { iceServers: [] }],
    ["entry with no urls", { iceServers: { username: "u" } }],
    ["entry with an empty urls array", { iceServers: { urls: [] } }],
  ])("returns nothing for %s, so the caller can log and fall back", (_label, body) => {
    expect(normalizeEntries(body)).toEqual([]);
  });
});
