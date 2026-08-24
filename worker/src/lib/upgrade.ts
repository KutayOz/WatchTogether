import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_RATE_LIMITED,
  CLOSE_REASONS,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
} from "./protocol";

/**
 * Refusing a WebSocket upgrade in a way the browser can actually read.
 *
 * `new WebSocket()` surfaces a rejected upgrade as close code 1006 and nothing
 * else — no status, no body. So a refusal that wants to explain itself has to
 * complete the handshake and then close with a specific code, which is the
 * contract protocol.ts states and the Durable Object has always honoured.
 *
 * This module exists because the *Worker* did not. It rejected unauthenticated
 * and rate-limited upgrades with a plain JSON 401/429 that no browser could
 * read, so every one of them reached the user as "Could not join the session."
 * — the client's fallback for a code it has no name for. The Durable Object's
 * own CLOSE_UNAUTHORIZED branch was unreachable as a result: the Worker never
 * forwarded a request without identity for it to catch.
 *
 * Worker-only. Not importable from the frontend, which type-checks
 * worker/src/lib through the `@shared` alias with DOM types and would choke on
 * WebSocketPair.
 */

/**
 * RFC 6455's `Upgrade` value is a case-insensitive token, and the exact
 * comparison this replaces turned a well-formed `Upgrade: WebSocket` into a
 * 426 — which, being a plain response to an upgrade request, reached the user
 * as the same contentless failure.
 */
export function isWebSocketUpgrade(request: Request): boolean {
  return request.headers.get("Upgrade")?.toLowerCase() === "websocket";
}

/**
 * Complete the handshake, then immediately close with `code`.
 *
 * `accept` is injected because the two runtimes that need this disagree about
 * which accept is correct, and picking one would break the other. A plain
 * Worker calls `socket.accept()`. A Durable Object must call
 * `state.acceptWebSocket(socket)` — that is the hibernation-manager
 * registration behind `getWebSockets()` and `webSocketClose`, and
 * `socket.accept()` there would bind the socket to the request's I/O context
 * instead, quietly losing both.
 */
export function rejectedUpgrade(
  code: number,
  accept: (socket: WebSocket) => void,
): Response {
  const { 0: client, 1: server } = new WebSocketPair();

  accept(server);
  server.close(code, CLOSE_REASONS[code] ?? CLOSE_REASONS[CLOSE_INTERNAL_ERROR]!);

  return new Response(null, { status: 101, webSocket: client });
}

/** The one route that speaks WebSocket. */
const WS_PATH_PREFIX = "/api/session/ws/";

/**
 * Status → close code. Everything the Worker layer can refuse an upgrade with.
 *
 * 403 joins 401 because both mean "not you", and the client has one piece of
 * advice for that. Anything unrecognised is ours, not the caller's, so it gets
 * CLOSE_INTERNAL_ERROR rather than a code implying they can fix it.
 */
function closeCodeFor(status: number): number {
  switch (status) {
    case 401:
    case 403:
      return CLOSE_UNAUTHORIZED;
    case 404:
      return CLOSE_SESSION_NOT_FOUND;
    case 429:
      return CLOSE_RATE_LIMITED;
    default:
      return CLOSE_INTERNAL_ERROR;
  }
}

/**
 * Convert a plain HTTP refusal of a WebSocket upgrade into a close code.
 *
 * Applied at the Worker's outermost boundary rather than as Hono middleware,
 * for the same reason withSecurityHeaders is: assigning `c.res` after
 * `await next()` reconstructs the Response, which drops the attached socket and
 * throws on a bodyless 101. Returning early from middleware does not work
 * either — a downstream 401 or 429 has already finalized the context.
 *
 * Sitting outside Hono also means this covers refusals from code that never
 * knew about WebSockets: both rate limiters, the auth layer, and the onError
 * 500. None of them needs a special case, and one added tomorrow gets this for
 * free.
 */
export function asUpgradeClose(request: Request, response: Response): Response {
  // Already a socket — the Durable Object's own refusals arrive this way, and
  // rebuilding one would undo the very thing it took care to do.
  if (response.status === 101 || response.webSocket) return response;

  if (!isWebSocketUpgrade(request)) return response;
  if (!new URL(request.url).pathname.startsWith(WS_PATH_PREFIX)) return response;

  return rejectedUpgrade(closeCodeFor(response.status), (socket) => socket.accept());
}
