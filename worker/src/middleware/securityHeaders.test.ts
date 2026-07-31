import { SELF, env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { withSecurityHeaders } from "./securityHeaders";

const ORIGIN = env.RP_ORIGIN;

/**
 * Headers every /api/* response must carry. Listed here rather than imported
 * from the module under test so that deleting one there fails a test instead of
 * quietly rewriting what the suite expects.
 */
const REQUIRED = [
  "Content-Security-Policy",
  "X-Content-Type-Options",
  "X-Frame-Options",
  "Referrer-Policy",
  "Cross-Origin-Resource-Policy",
  "Strict-Transport-Security",
  "Cache-Control",
];

describe("security headers on API responses", () => {
  it("sets them on a plain 200", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/health`);

    expect(res.status).toBe(200);
    for (const name of REQUIRED) expect(res.headers.get(name)).not.toBeNull();
    expect(res.headers.get("Content-Security-Policy")).toContain("default-src 'none'");
    expect(res.headers.get("Cache-Control")).toBe("no-store");
  });

  /**
   * Error paths are the ones that get forgotten, and they are also the ones an
   * attacker reaches first. Hono builds these two responses itself, outside any
   * route handler.
   */
  it("sets them on a 404 from the catch-all", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/no-such-route`);

    expect(res.status).toBe(404);
    for (const name of REQUIRED) expect(res.headers.get(name)).not.toBeNull();
  });

  it("sets them on a 401", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/session/create`, { method: "POST" });

    expect(res.status).toBe(401);
    for (const name of REQUIRED) expect(res.headers.get(name)).not.toBeNull();
  });

  /**
   * The frontend reads `.message` off error bodies. Copying the response to get
   * mutable headers must not cost the body.
   */
  it("leaves the body readable", async () => {
    const res = await SELF.fetch(`${ORIGIN}/api/no-such-route`);
    expect(await res.json()).toEqual({ message: "Not found" });
  });
});

describe("withSecurityHeaders", () => {
  it("does not overwrite a header the handler set itself", () => {
    const res = withSecurityHeaders(
      new Response("{}", { headers: { "Cache-Control": "public, max-age=60" } }),
    );

    expect(res.headers.get("Cache-Control")).toBe("public, max-age=60");
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  /**
   * A 101's response belongs to the runtime: the socket rides on it, and
   * rebuilding it would drop the socket while the client waited forever for a
   * `Joined` frame. Reconstructing one is also simply illegal — the Response
   * constructor rejects a 101 unless a webSocket comes with it.
   */
  it("returns a websocket upgrade untouched, socket and all", () => {
    const pair = new WebSocketPair();
    const original = new Response(null, { status: 101, webSocket: pair[0] });

    const res = withSecurityHeaders(original);

    expect(res).toBe(original);
    expect(res.webSocket).toBe(pair[0]);
  });

  /**
   * `new Response(body, init)` throws for statuses that must have a null body,
   * so the copy has to drop it rather than pass it through.
   */
  it.each([204, 205, 304])("copies a %i without throwing on its null body", (status) => {
    const res = withSecurityHeaders(new Response(null, { status }));

    expect(res.status).toBe(status);
    expect(res.headers.get("X-Content-Type-Options")).toBe("nosniff");
  });

  /**
   * Durable Objects reply through `fetch()`, and a fetched Response has
   * immutable headers — setting one throws rather than being ignored. This is
   * the case that forced a copy instead of a mutation.
   */
  it("adds headers to a response whose own headers are immutable", async () => {
    const fetched = await SELF.fetch(`${ORIGIN}/api/health`);
    // Prove the premise before relying on it.
    expect(() => fetched.headers.set("X-Probe", "1")).toThrow();

    expect(withSecurityHeaders(fetched).headers.get("X-Content-Type-Options")).toBe("nosniff");
  });
});
