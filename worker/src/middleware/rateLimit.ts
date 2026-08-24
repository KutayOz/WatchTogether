import type { MiddlewareHandler } from "hono";
import type { AppEnv } from "./auth";

/**
 * Rate limiting via the Workers rate-limit binding.
 *
 * Chosen over a Durable Object counter because it costs no requests, no object
 * time and no storage — on a free plan where Durable Object requests are the
 * scarce resource, a limiter that consumes them defeats its own purpose.
 *
 * Two honest limitations. The binding's window is 10 or 60 seconds only, so the
 * .NET policies with 5- and 15-minute windows cannot be expressed; the real
 * gate on registration is that invites are single-use and quota-limited
 * anyway. And it counts per colo rather than globally, so a geographically
 * distributed attacker gets the limit multiplied by the number of colos they
 * reach. For a private two-person app that is an acceptable trade.
 */
export type RateLimitName =
  | "RL_GLOBAL"
  | "RL_AUTH"
  | "RL_LOOKUP"
  | "RL_PASSWORD"
  | "RL_DEMO";

/**
 * Client IP.
 *
 * CF-Connecting-IP is set by the edge and cannot be spoofed by the client,
 * which replaces the whole forwarded-headers dance the .NET app needed
 * (Program.cs:404-413) — and the trust-the-proxy misconfiguration that came
 * with it.
 */
function clientIp(headers: Headers): string {
  // Absent under `wrangler dev`, so fall back rather than throwing locally.
  return headers.get("CF-Connecting-IP") ?? "local-dev";
}

export function rateLimit(name: RateLimitName): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const limiter = c.env[name];

    // Not bound in tests or local dev; skipping is correct there rather than
    // failing every request.
    if (!limiter?.limit) return next();

    const { success } = await limiter.limit({ key: clientIp(c.req.raw.headers) });
    if (success) return next();

    // Shape matches what the frontend already parses (Program.cs:347-363).
    return c.json({ message: "Too many requests. Please slow down.", retryAfterSeconds: 60 }, 429, {
      "Retry-After": "60",
    });
  };
}
