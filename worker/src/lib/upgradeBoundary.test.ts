import { describe, expect, it } from "vitest";
import {
  CLOSE_INTERNAL_ERROR,
  CLOSE_RATE_LIMITED,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
} from "./protocol";
import { asUpgradeClose } from "./upgrade";

/**
 * The status → close-code mapping, exercised without a Worker.
 *
 * session.test.ts proves the boundary is wired in; this proves it translates
 * correctly, including the cases no route produces today but onError might
 * tomorrow.
 */

const WS_URL = "https://app.example/api/session/ws/abc123";

const upgradeRequest = (url = WS_URL) =>
  new Request(url, { headers: { Upgrade: "websocket" } });

async function closeCodeOf(response: Response): Promise<number> {
  const ws = response.webSocket!;
  const closes: number[] = [];
  ws.addEventListener("close", (event) => {
    closes.push(event.code);
  });
  ws.accept();

  for (let i = 0; i < 50 && closes.length === 0; i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return closes[0]!;
}

describe("asUpgradeClose", () => {
  it.each([
    [401, CLOSE_UNAUTHORIZED],
    [403, CLOSE_UNAUTHORIZED],
    [404, CLOSE_SESSION_NOT_FOUND],
    [429, CLOSE_RATE_LIMITED],
    [500, CLOSE_INTERNAL_ERROR],
    [426, CLOSE_INTERNAL_ERROR],
  ])("converts %i into close code %i", async (status, expected) => {
    const converted = asUpgradeClose(
      upgradeRequest(),
      Response.json({ message: "no" }, { status }),
    );

    expect(converted.status).toBe(101);
    expect(await closeCodeOf(converted)).toBe(expected);
  });

  it("leaves a successful upgrade alone", () => {
    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    const original = new Response(null, { status: 101, webSocket: client });

    expect(asUpgradeClose(upgradeRequest(), original)).toBe(original);
  });

  it("leaves a request that never asked for an upgrade alone", () => {
    const original = Response.json({ message: "Unauthorized" }, { status: 401 });

    expect(asUpgradeClose(new Request(WS_URL), original)).toBe(original);
  });

  it("leaves every other route's failures alone", () => {
    const original = Response.json({ message: "Unauthorized" }, { status: 401 });
    const request = new Request("https://app.example/api/auth/me", {
      headers: { Upgrade: "websocket" },
    });

    // An Upgrade header on an unrelated route is not our business to reinterpret.
    expect(asUpgradeClose(request, original)).toBe(original);
  });
});
