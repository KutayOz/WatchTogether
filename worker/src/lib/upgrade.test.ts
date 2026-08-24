import { describe, expect, it } from "vitest";
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_RATE_LIMITED,
  CLOSE_UNAUTHORIZED,
} from "./protocol";
import { isWebSocketUpgrade, rejectedUpgrade } from "./upgrade";

/** Let queued socket events drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Read the close a rejected upgrade delivers.
 *
 * This is the whole point of the module: a plain Worker's socket is bound to
 * the request's I/O context rather than a hibernation manager, so whether the
 * queued close frame survives the handler returning is the one thing that had
 * to be proved rather than reasoned about.
 */
async function closeFrom(response: Response) {
  const ws = response.webSocket!;
  const closes: { code: number; reason: string }[] = [];
  ws.addEventListener("close", (event) => {
    closes.push({ code: event.code, reason: event.reason });
  });
  ws.accept();

  for (let i = 0; i < 50 && closes.length === 0; i++) await settle();
  return closes[0];
}

describe("isWebSocketUpgrade", () => {
  it.each([
    ["websocket", true],
    ["WebSocket", true],
    ["WEBSOCKET", true],
  ])("accepts %s as an upgrade", (value, expected) => {
    const request = new Request("https://example.com/", { headers: { Upgrade: value } });
    expect(isWebSocketUpgrade(request)).toBe(expected);
  });

  it("rejects a request with no Upgrade header", () => {
    expect(isWebSocketUpgrade(new Request("https://example.com/"))).toBe(false);
  });

  it("rejects an upgrade to some other protocol", () => {
    const request = new Request("https://example.com/", { headers: { Upgrade: "h2c" } });
    expect(isWebSocketUpgrade(request)).toBe(false);
  });
});

describe("rejectedUpgrade", () => {
  it("completes the handshake so the browser can read the reason", async () => {
    const response = rejectedUpgrade(CLOSE_UNAUTHORIZED, (socket) => socket.accept());

    expect(response.status).toBe(101);
    expect(response.webSocket).toBeTruthy();
    expect(await closeFrom(response)).toEqual({
      code: CLOSE_UNAUTHORIZED,
      reason: "unauthorized",
    });
  });

  it("carries the reason for every code it is given", async () => {
    const response = rejectedUpgrade(CLOSE_RATE_LIMITED, (socket) => socket.accept());
    expect(await closeFrom(response)).toEqual({
      code: CLOSE_RATE_LIMITED,
      reason: "rate_limited",
    });
  });

  it("falls back to a named reason rather than an empty one", async () => {
    // 4999 is deliberately absent from CLOSE_REASONS.
    const response = rejectedUpgrade(4999, (socket) => socket.accept());
    expect(await closeFrom(response)).toEqual({ code: 4999, reason: "internal_error" });
  });

  it("uses the injected accept rather than assuming one", () => {
    let accepted: WebSocket | null = null;
    rejectedUpgrade(CLOSE_INTERNAL_ERROR, (socket) => {
      accepted = socket;
      socket.accept();
    });

    expect(accepted).not.toBeNull();
  });
});
