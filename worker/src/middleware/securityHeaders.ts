/**
 * Security headers for /api/* responses.
 *
 * Split brain, deliberately: the SPA's headers live in
 * frontend/public/_headers because static assets never invoke this Worker
 * (`run_worker_first = ["/api/*"]`), and a Worker cannot add headers to a
 * response it never sees. This module covers the other half.
 *
 * Everything here answers JSON, so the policy is the strictest one there is —
 * `default-src 'none'` forbids the browser loading anything at all should a
 * response ever be rendered as a document. The three directives that do NOT
 * fall back to default-src are spelled out, since omitting them is the usual
 * way a "locked down" policy turns out not to be.
 */
const API_HEADERS: ReadonlyArray<readonly [string, string]> = [
  ["Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"],
  ["X-Content-Type-Options", "nosniff"],
  ["X-Frame-Options", "DENY"],
  // No referrer at all: invite tokens travel in the URL path, and an API
  // response has no links for a useful referrer to serve.
  ["Referrer-Policy", "no-referrer"],
  ["Cross-Origin-Resource-Policy", "same-origin"],
  ["Strict-Transport-Security", "max-age=31536000; includeSubDomains"],
  // Authenticated JSON, none of it revalidatable. Keeps a shared cache — or a
  // browser's back/forward cache — from holding one user's data.
  ["Cache-Control", "no-store"],
];

/** Statuses whose responses must have a null body; reusing one throws. */
const NULL_BODY_STATUS = new Set([101, 204, 205, 304]);

/**
 * Returns a copy of `res` carrying the headers above, leaving any the handler
 * set itself alone.
 *
 * A copy rather than a mutation because responses that came back from a
 * `fetch()` — every Durable Object reply — have immutable headers, and
 * assigning to those throws rather than failing quietly.
 */
export function withSecurityHeaders(res: Response): Response {
  // A WebSocket upgrade is the runtime's to own. There is no document to
  // protect, the browser reads no headers off a 101, and rebuilding the
  // response would drop the socket attached to it.
  if (res.status === 101 || res.webSocket) return res;

  const out = new Response(NULL_BODY_STATUS.has(res.status) ? null : res.body, res);
  for (const [name, value] of API_HEADERS) {
    if (!out.headers.has(name)) out.headers.set(name, value);
  }
  return out;
}
