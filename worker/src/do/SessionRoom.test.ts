import { env, runDurableObjectAlarm, runInDurableObject } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import {
  CLOSE_PAYLOAD_TOO_LARGE,
  CLOSE_REPLACED,
  CLOSE_SESSION_FULL,
  CLOSE_SESSION_NOT_FOUND,
  CLOSE_UNAUTHORIZED,
  MAX_FRAME_BYTES,
  type ServerMessage,
} from "../lib/protocol";

let counter = 0;
/** Fresh id per test — Durable Object state is keyed by name and would leak. */
const nextSessionId = () => `test-session-${counter++}`;

function stubFor(sessionId: string) {
  return env.SESSION.get(env.SESSION.idFromName(sessionId));
}

async function createSession(creatorUserId: string) {
  const sessionId = nextSessionId();
  const stub = stubFor(sessionId);
  await stub.fetch("https://do/create", {
    method: "POST",
    body: JSON.stringify({ creatorUserId }),
  });
  return { sessionId, stub };
}

interface Peer {
  ws: WebSocket;
  received: ServerMessage[];
  closes: { code: number; reason: string }[];
  types(): string[];
  waitFor(type: string): Promise<ServerMessage>;
}

async function connect(
  stub: DurableObjectStub,
  userId: string | null,
  username: string | null,
): Promise<Peer> {
  const headers: Record<string, string> = { Upgrade: "websocket" };
  if (userId) headers["X-WT-User-Id"] = userId;
  if (username) headers["X-WT-Username"] = username;

  const response = await stub.fetch("https://do/ws", { headers });
  const ws = response.webSocket!;
  ws.accept();

  const received: ServerMessage[] = [];
  const closes: { code: number; reason: string }[] = [];
  ws.addEventListener("message", (event) => {
    received.push(JSON.parse(event.data as string) as ServerMessage);
  });
  ws.addEventListener("close", (event) => {
    closes.push({ code: event.code, reason: event.reason });
  });

  const peer: Peer = {
    ws,
    received,
    closes,
    types: () => received.map((m) => m.t),
    async waitFor(type) {
      for (let i = 0; i < 50; i++) {
        const found = received.find((m) => m.t === type);
        if (found) return found;
        await settle();
      }
      throw new Error(`timed out waiting for ${type}; saw [${peer.types().join(", ")}]`);
    },
  };
  return peer;
}

/** Let queued socket events drain. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function send(peer: Peer, t: string, d: unknown) {
  peer.ws.send(JSON.stringify({ t, d }));
}

let drainSeq = 0;
/**
 * Wait until the room has processed everything this peer has sent so far.
 *
 * Delivery is asynchronous, so a fixed pause between "declare a share" and
 * "connect someone to read it back" is a race — one that passes on a quiet
 * laptop and fails on a loaded runner. chat is the one message echoed to its
 * own sender, and a socket's frames are processed in order, so the echo coming
 * back is proof that everything queued ahead of it has landed.
 */
async function drain(peer: Peer): Promise<void> {
  const marker = `drain-${++drainSeq}`;
  send(peer, "chat", { m: marker });

  for (let i = 0; i < 50; i++) {
    const seen = peer.received.some(
      (m) => m.t === "ReceiveChatMessage" && (m.d as { message?: string }).message === marker,
    );
    if (seen) return;
    await settle();
  }
  throw new Error(`timed out draining ${marker}`);
}

describe("session lifecycle", () => {
  it("reports a session that was never created as non-existent", async () => {
    const response = await stubFor(nextSessionId()).fetch("https://do/state");
    expect(await response.json()).toMatchObject({ exists: false, participantCount: 0 });
  });

  it("creates once and is idempotent", async () => {
    const { stub } = await createSession("creator");

    const second = await stub.fetch("https://do/create", {
      method: "POST",
      body: JSON.stringify({ creatorUserId: "someone-else" }),
    });

    expect(await second.json()).toEqual({ created: false });
    expect(await (await stub.fetch("https://do/state")).json()).toMatchObject({
      exists: true,
      creatorUserId: "creator",
    });
  });

  it("rejects a socket with no identity", async () => {
    const { stub } = await createSession("creator");
    const peer = await connect(stub, null, null);
    await settle();

    expect(peer.closes[0]?.code).toBe(CLOSE_UNAUTHORIZED);
  });

  it("rejects a socket for a session that does not exist", async () => {
    const peer = await connect(stubFor(nextSessionId()), "u1", "alice");
    await settle();

    expect(peer.closes[0]?.code).toBe(CLOSE_SESSION_NOT_FOUND);
  });
});

describe("join", () => {
  it("tells the creator they are the offerer and the joiner they are not", async () => {
    const { stub } = await createSession("creator");

    const creator = await connect(stub, "creator", "Kutay");
    expect((await creator.waitFor("Joined")).d).toMatchObject({
      you: { userId: "creator", username: "Kutay" },
      isOfferer: true,
      capacity: 2,
    });

    const guest = await connect(stub, "guest", "Ada");
    expect((await guest.waitFor("Joined")).d).toMatchObject({ isOfferer: false });
  });

  it("announces to the room before telling the newcomer who is here", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    await settle();

    // Ordering is load-bearing: the existing peer learns of the newcomer and
    // starts the offer, while the newcomer only learns who is present.
    expect(creator.types()).toContain("PeerJoined");
    expect(guest.types()).toEqual(["ExistingPeer", "Joined"]);
    expect((guest.received[0] as { d: { name: string } }).d.name).toBe("Kutay");
  });

  it("does not tell a lone creator about any existing peer", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    expect(creator.types()).toEqual(["Joined"]);
  });

  it("refuses a third participant", async () => {
    const { stub } = await createSession("creator");
    await (await connect(stub, "creator", "Kutay")).waitFor("Joined");
    await (await connect(stub, "guest", "Ada")).waitFor("Joined");

    const third = await connect(stub, "gatecrasher", "Eve");
    await settle();

    expect(third.closes[0]?.code).toBe(CLOSE_SESSION_FULL);
  });

  it("frees the slot once a participant leaves", async () => {
    const { stub } = await createSession("creator");
    await (await connect(stub, "creator", "Kutay")).waitFor("Joined");

    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    guest.ws.close();
    await settle();

    const replacement = await connect(stub, "later", "Bob");
    await expect(replacement.waitFor("Joined")).resolves.toBeDefined();
  });
});

describe("reconnect", () => {
  it("replaces a user's ghost socket instead of refusing them", async () => {
    const { stub } = await createSession("creator");
    const first = await connect(stub, "creator", "Kutay");
    await first.waitFor("Joined");

    // Same user, new socket, without the old one having closed cleanly — the
    // exact shape of a dropped connection whose close has not yet fired.
    const second = await connect(stub, "creator", "Kutay");
    await settle();

    expect(first.closes[0]?.code).toBe(CLOSE_REPLACED);
    await expect(second.waitFor("Joined")).resolves.toBeDefined();
  });

  it("does not let a user's own second tab fill a two-person room", async () => {
    const { stub } = await createSession("creator");
    await (await connect(stub, "creator", "Kutay")).waitFor("Joined");
    await (await connect(stub, "creator", "Kutay")).waitFor("Joined");

    const guest = await connect(stub, "guest", "Ada");
    await expect(guest.waitFor("Joined")).resolves.toBeDefined();
  });

  it("signals a rejoin as PeerReconnected, not PeerJoined", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    await creator.waitFor("PeerJoined");

    await connect(stub, "guest", "Ada");
    // The distinction matters: the offerer must renegotiate on a reconnect,
    // whereas a fresh join drives the initial offer.
    await expect(creator.waitFor("PeerReconnected")).resolves.toBeDefined();
  });
});

describe("relay semantics", () => {
  it("echoes chat back to its sender", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");

    send(creator, "chat", { m: "hello" });

    // The frontend never appends its own messages locally, so losing this echo
    // makes the sender's own chat look empty to them.
    const own = await creator.waitFor("ReceiveChatMessage");
    expect(own.d).toMatchObject({ sender: "Kutay", message: "hello" });
    const theirs = await guest.waitFor("ReceiveChatMessage");
    expect(theirs.d).toMatchObject({ sender: "Kutay", message: "hello" });
  });

  it("stamps chat server-side rather than trusting the sender", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    send(creator, "chat", { m: "hi", sender: "Impostor", timestamp: "1999-01-01T00:00:00Z" });
    const message = (await creator.waitFor("ReceiveChatMessage")).d as {
      sender: string;
      timestamp: string;
    };

    expect(message.sender).toBe("Kutay");
    expect(new Date(message.timestamp).getFullYear()).toBe(new Date().getFullYear());
  });

  it.each([
    ["offer", { sdp: "v=0 fake" }, "ReceiveOffer"],
    ["answer", { sdp: "v=0 fake" }, "ReceiveAnswer"],
    ["ice", { c: "candidate:1 1 udp" }, "ReceiveIceCandidate"],
    ["reoffer", { sdp: "v=0 fake" }, "ReceiveRenegotiationOffer"],
    ["reanswer", { sdp: "v=0 fake" }, "ReceiveRenegotiationAnswer"],
    ["ss:req", {}, "ScreenShareRequested"],
    ["ss:res", { approved: true }, "ScreenShareResponse"],
    ["ss:start", { streamId: "stream-1" }, "ScreenShareStarted"],
    ["ss:stop", {}, "ScreenShareStopped"],
    ["media", { isMuted: true, isCameraOn: false, isScreenSharing: false }, "PeerMediaStateChanged"],
  ])("relays %s to the peer and never back to the sender", async (type, payload, expected) => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    await settle();

    const before = creator.received.length;
    send(creator, type, payload);
    await expect(guest.waitFor(expected)).resolves.toBeDefined();

    // Anything echoed here would double-render on the sender. Reactions in
    // particular are already echoed locally by the client.
    expect(creator.received.slice(before).map((m) => m.t)).not.toContain(expected);
  });

  it("announces departure to the remaining peer", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");

    send(guest, "leave", {});

    expect((await creator.waitFor("PeerLeft")).d).toMatchObject({ name: "Ada" });
  });
});

describe("screen-share state", () => {
  /*
   * The room records who is sharing, and every joiner is told.
   *
   * It relays the other two share frames and forgets them, but ss:start and
   * ss:stop are different in kind: they are the only ones whose effect outlives
   * the moment they arrive. Leaving them to the clients meant each side kept a
   * private copy of the other's state that nothing could ever correct — a stop
   * lost to a dropped socket left the viewer convinced a share was still
   * running, and from then on it refused every request that peer made, forever.
   */
  it("tells a joiner that the peer is already sharing", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    send(creator, "ss:start", { streamId: "stream-abc" });
    await drain(creator);

    const guest = await connect(stub, "guest", "Ada");
    expect((await guest.waitFor("ExistingPeer")).d).toMatchObject({
      name: "Kutay",
      sharing: "stream-abc",
    });
  });

  it("reports no share when the peer never started one", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    const guest = await connect(stub, "guest", "Ada");
    expect((await guest.waitFor("ExistingPeer")).d).toMatchObject({
      name: "Kutay",
      sharing: null,
    });
  });

  it("forgets the share once it is stopped", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    send(creator, "ss:start", { streamId: "stream-abc" });
    send(creator, "ss:stop", {});
    await drain(creator);

    const guest = await connect(stub, "guest", "Ada");
    expect((await guest.waitFor("ExistingPeer")).d).toMatchObject({ sharing: null });
  });

  it("starts a reconnecting sharer's new socket with nothing declared", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    send(creator, "ss:start", { streamId: "stream-abc" });
    await drain(creator);

    // Same user, new socket — the flap the client recovers from by re-declaring.
    // The room must not carry the old socket's claim forward: after a reload the
    // share is genuinely gone, and only the client knows which of the two it is.
    const rejoined = await connect(stub, "creator", "Kutay");
    await rejoined.waitFor("Joined");
    await settle();

    const guest = await connect(stub, "guest", "Ada");
    expect((await guest.waitFor("ExistingPeer")).d).toMatchObject({ sharing: null });
  });

  it("keeps the sharer's own declaration off their own ExistingPeer list", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    await settle();

    send(guest, "ss:start", { streamId: "guest-stream" });
    await drain(guest);

    // A third socket for the creator sees the guest sharing, not itself.
    const rejoined = await connect(stub, "creator", "Kutay");
    const existing = await rejoined.waitFor("ExistingPeer");
    expect(existing.d).toMatchObject({ name: "Ada", sharing: "guest-stream" });
  });
});

describe("input guards", () => {
  it("closes a socket that sends an oversized frame", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    creator.ws.send("x".repeat(MAX_FRAME_BYTES + 1));
    await settle();

    expect(creator.closes[0]?.code).toBe(CLOSE_PAYLOAD_TOO_LARGE);
  });

  it.each([
    ["an over-cap SDP", "offer", { sdp: "v".repeat(30_001) }],
    ["a blank SDP", "offer", { sdp: "   " }],
    ["an over-cap chat message", "chat", { m: "m".repeat(5_001) }],
    ["a malformed media state", "media", { isMuted: "yes" }],
    ["an unknown verb", "definitely-not-a-verb", {}],
  ])("drops %s, and tells the sender why", async (_label, type, payload) => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    const guest = await connect(stub, "guest", "Ada");
    await guest.waitFor("Joined");
    await settle();

    const before = guest.received.length;
    send(creator, type, payload);

    // Not silent any more. An over-cap SDP is the case that mattered: the
    // sharer believed it had renegotiated while the viewer's picture froze on a
    // connection both ends reported as healthy, and nothing anywhere said why.
    //
    // Waited for rather than checked after a fixed settle. One frame's delivery
    // does not fit reliably in 10 ms on a loaded CI runner, and a fixed pause
    // turns "the room answered" into "the room answered fast enough".
    await expect(creator.waitFor("Error")).resolves.toBeDefined();

    // And by then the relay that never happened has had every chance to.
    expect(guest.received.length).toBe(before);
    expect(creator.closes).toHaveLength(0);
  });

  it("survives a non-JSON frame", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    creator.ws.send("not json at all");
    await settle();

    expect(creator.closes).toHaveLength(0);
  });
});

describe("session invites", () => {
  it("mints, redeems once, and refuses reuse", async () => {
    const { stub } = await createSession("creator");

    const minted = await (
      await stub.fetch("https://do/invite", {
        method: "POST",
        body: JSON.stringify({ userId: "creator" }),
      })
    ).json<{ ok: boolean; secret: string }>();
    expect(minted.ok).toBe(true);

    const redeem = (userId: string) =>
      stub
        .fetch("https://do/invite/redeem", {
          method: "POST",
          body: JSON.stringify({ secret: minted.secret, userId }),
        })
        .then((r) => r.json<{ ok: boolean; error?: string }>());

    expect(await redeem("guest")).toMatchObject({ ok: true });
    expect(await redeem("gatecrasher")).toMatchObject({ ok: false, error: "already_used" });
  });

  it("only lets the creator mint", async () => {
    const { stub } = await createSession("creator");

    const response = await stub.fetch("https://do/invite", {
      method: "POST",
      body: JSON.stringify({ userId: "not-the-creator" }),
    });

    expect(response.status).toBe(403);
  });

  /**
   * A deliberate divergence from GenerateInvite in the .NET SessionService,
   * which handed back the still-valid invite rather than minting a second one.
   * Overwriting is the more useful behaviour — it makes "generate link" double
   * as "revoke the one I pasted in the wrong window" — but it is a behaviour
   * change, so it is pinned here rather than left to be rediscovered.
   */
  it("replaces the previous invite when the creator mints again", async () => {
    const { stub } = await createSession("creator");
    const mint = () =>
      stub
        .fetch("https://do/invite", { method: "POST", body: JSON.stringify({ userId: "creator" }) })
        .then((r) => r.json<{ secret: string }>());

    const first = await mint();
    const second = await mint();

    const redeem = (secret: string) =>
      stub
        .fetch("https://do/invite/redeem", {
          method: "POST",
          body: JSON.stringify({ secret, userId: "guest" }),
        })
        .then((r) => r.json<{ ok: boolean; error?: string }>());

    expect(second.secret).not.toBe(first.secret);
    expect(await redeem(first.secret)).toMatchObject({ ok: false, error: "invalid" });
    expect(await redeem(second.secret)).toMatchObject({ ok: true });
  });

  it("rejects a wrong secret", async () => {
    const { stub } = await createSession("creator");
    await stub.fetch("https://do/invite", {
      method: "POST",
      body: JSON.stringify({ userId: "creator" }),
    });

    const response = await stub.fetch("https://do/invite/redeem", {
      method: "POST",
      body: JSON.stringify({ secret: "wrong-secret", userId: "guest" }),
    });

    expect(await response.json()).toMatchObject({ ok: false, error: "invalid" });
  });
});

describe("grace period", () => {
  it("keeps an occupied session alive when the alarm fires", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    await runInDurableObject(stub, async (_instance, state) => {
      // Pretend the room emptied long ago; occupancy should still win.
      const meta = await state.storage.get<Record<string, unknown>>("meta");
      await state.storage.put("meta", { ...meta, emptySince: Date.now() - 60 * 60 * 1000 });
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    expect(await (await stub.fetch("https://do/state")).json()).toMatchObject({ exists: true });
  });

  it("deletes an empty session once the grace period has passed", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");
    creator.ws.close();
    await settle();

    await runInDurableObject(stub, async (_instance, state) => {
      const meta = await state.storage.get<Record<string, unknown>>("meta");
      await state.storage.put("meta", { ...meta, emptySince: Date.now() - 60 * 60 * 1000 });
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    // Existence is storage existence — deleteAll IS the deletion. No registry
    // to update, no tombstone to sweep.
    expect(await (await stub.fetch("https://do/state")).json()).toMatchObject({ exists: false });
  });

  it("expires an unredeemed invite without deleting an occupied session", async () => {
    const { stub } = await createSession("creator");
    const creator = await connect(stub, "creator", "Kutay");
    await creator.waitFor("Joined");

    const minted = await (
      await stub.fetch("https://do/invite", {
        method: "POST",
        body: JSON.stringify({ userId: "creator" }),
      })
    ).json<{ secret: string }>();

    await runInDurableObject(stub, async (_instance, state) => {
      const meta = await state.storage.get<Record<string, unknown>>("meta");
      await state.storage.put("meta", { ...meta, inviteExpiresAt: Date.now() - 1000 });
      await state.storage.setAlarm(Date.now());
    });
    await runDurableObjectAlarm(stub);

    const redeemed = await (
      await stub.fetch("https://do/invite/redeem", {
        method: "POST",
        body: JSON.stringify({ secret: minted.secret, userId: "guest" }),
      })
    ).json();

    expect(redeemed).toMatchObject({ ok: false, error: "invalid" });
    expect(await (await stub.fetch("https://do/state")).json()).toMatchObject({ exists: true });
  });
});
