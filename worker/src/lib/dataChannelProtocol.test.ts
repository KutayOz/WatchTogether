import { describe, expect, it } from "vitest";
import {
  CONTROL_CHANNEL,
  FAST_CHANNEL,
  MAX_DATA_FRAME_BYTES,
  MAX_EMOJI_LENGTH,
  MAX_VIDEO_SYNC_PAYLOAD_LENGTH,
  channelFor,
  decodeDataChannelMessage,
  encodeData,
  type DataChannelMessage,
} from "./dataChannelProtocol";

/**
 * These frames arrive over a direct peer-to-peer link with no server in
 * between, from a client we do not control. This decoder is the only thing
 * standing between a modified peer and the React state it feeds.
 */
describe("data channel decoding", () => {
  const roundTrip = (message: DataChannelMessage) =>
    decodeDataChannelMessage(encodeData(message));

  it("round-trips every message type", () => {
    const messages: DataChannelMessage[] = [
      { t: "cursor", d: { x: 0.25, y: 0.75 } },
      { t: "typing", d: {} },
      { t: "reaction", d: { emoji: "🩷" } },
      { t: "videoSync", d: { action: "seek", payload: "42.5" } },
      {
        t: "quality",
        d: {
          feedback: {
            level: "poor",
            score: 40,
            packetLossPercent: 3.2,
            jitterMs: 18,
            rttMs: 140,
            fps: 22,
          },
        },
      },
    ];

    for (const message of messages) {
      expect(roundTrip(message)).toEqual(message);
    }
  });

  it.each([
    ["not JSON at all", "}{"],
    ["a bare string", '"hello"'],
    ["null", "null"],
    ["an array", "[]"],
    ["no type", '{"d":{}}'],
    ["a numeric type", '{"t":1,"d":{}}'],
    ["no payload", '{"t":"typing"}'],
    ["a null payload", '{"t":"typing","d":null}'],
    ["an unknown type", '{"t":"exec","d":{}}'],
  ])("drops %s", (_label, raw) => {
    expect(decodeDataChannelMessage(raw)).toBeNull();
  });

  describe("cursor", () => {
    it.each([
      ["above 1", { x: 1.5, y: 0.5 }],
      ["below 0", { x: -0.1, y: 0.5 }],
      ["NaN", { x: Number.NaN, y: 0.5 }],
      ["Infinity", { x: Number.POSITIVE_INFINITY, y: 0.5 }],
      ["a string", { x: "0.5", y: 0.5 }],
      ["missing y", { x: 0.5 }],
    ])("rejects %s", (_label, d) => {
      expect(decodeDataChannelMessage(JSON.stringify({ t: "cursor", d }))).toBeNull();
    });

    it("accepts the exact bounds", () => {
      expect(roundTrip({ t: "cursor", d: { x: 0, y: 1 } })).toEqual({
        t: "cursor",
        d: { x: 0, y: 1 },
      });
    });

    // NaN survives `typeof x === "number"`, and NaN coordinates propagate
    // straight into a CSS transform, which silently parks the halo nowhere.
    it("rejects NaN, which a typeof check alone would let through", () => {
      expect(typeof Number.NaN).toBe("number");
      expect(decodeDataChannelMessage('{"t":"cursor","d":{"x":null,"y":0.5}}')).toBeNull();
    });
  });

  describe("reaction", () => {
    it("rejects an empty emoji", () => {
      expect(decodeDataChannelMessage('{"t":"reaction","d":{"emoji":""}}')).toBeNull();
    });

    it("rejects an emoji past the cap", () => {
      const emoji = "x".repeat(MAX_EMOJI_LENGTH + 1);
      expect(decodeDataChannelMessage(JSON.stringify({ t: "reaction", d: { emoji } }))).toBeNull();
    });

    it("accepts a multi-codepoint emoji", () => {
      // Family sequences are long in UTF-16 units; the cap has to leave room.
      const emoji = "👩‍❤️‍👩";
      expect(emoji.length).toBeLessThanOrEqual(MAX_EMOJI_LENGTH);
      expect(roundTrip({ t: "reaction", d: { emoji } })).toEqual({ t: "reaction", d: { emoji } });
    });
  });

  describe("videoSync", () => {
    it.each(["load", "close", "play", "pause", "seek"] as const)("accepts %s", (action) => {
      expect(roundTrip({ t: "videoSync", d: { action, payload: "1" } })).toBeTruthy();
    });

    it("rejects an unknown action", () => {
      expect(
        decodeDataChannelMessage('{"t":"videoSync","d":{"action":"delete","payload":""}}'),
      ).toBeNull();
    });

    it("rejects an oversized payload", () => {
      const payload = "9".repeat(MAX_VIDEO_SYNC_PAYLOAD_LENGTH + 1);
      expect(
        decodeDataChannelMessage(JSON.stringify({ t: "videoSync", d: { action: "seek", payload } })),
      ).toBeNull();
    });

    it("accepts an empty payload, which is what close sends", () => {
      expect(roundTrip({ t: "videoSync", d: { action: "close", payload: "" } })).toEqual({
        t: "videoSync",
        d: { action: "close", payload: "" },
      });
    });
  });

  describe("quality", () => {
    const feedback = {
      level: "good",
      score: 80,
      packetLossPercent: 0.5,
      jitterMs: 8,
      rttMs: 40,
      fps: 30,
    };

    it("rejects an unknown level", () => {
      expect(
        decodeDataChannelMessage(
          JSON.stringify({ t: "quality", d: { feedback: { ...feedback, level: "amazing" } } }),
        ),
      ).toBeNull();
    });

    it("rejects a non-finite metric", () => {
      expect(
        decodeDataChannelMessage(
          `{"t":"quality","d":{"feedback":{"level":"good","score":80,"packetLossPercent":0.5,"jitterMs":8,"rttMs":40,"fps":null}}}`,
        ),
      ).toBeNull();
    });

    it("drops unknown extra fields rather than passing them through", () => {
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "quality", d: { feedback: { ...feedback, evil: "payload" } } }),
      );
      expect(decoded).toBeTruthy();
      expect(decoded!.d).not.toHaveProperty("feedback.evil");
      expect(Object.keys((decoded!.d as { feedback: object }).feedback).sort()).toEqual([
        "fps",
        "jitterMs",
        "level",
        "packetLossPercent",
        "rttMs",
        "score",
      ]);
    });
  });

  it("rejects an oversized frame before parsing it", () => {
    const huge = JSON.stringify({ t: "typing", d: {}, pad: "x".repeat(MAX_DATA_FRAME_BYTES) });
    expect(huge.length).toBeGreaterThan(MAX_DATA_FRAME_BYTES);
    expect(decodeDataChannelMessage(huge)).toBeNull();
  });
});

describe("channel routing", () => {
  it("sends only cursors down the unreliable channel", () => {
    expect(channelFor("cursor")).toBe("fast");
    for (const type of ["typing", "reaction", "videoSync", "quality"] as const) {
      expect(channelFor(type)).toBe("control");
    }
  });

  it("gives the two channels distinct ids, since both ends create them blind", () => {
    expect(FAST_CHANNEL.id).not.toBe(CONTROL_CHANNEL.id);
    expect(FAST_CHANNEL.label).not.toBe(CONTROL_CHANNEL.label);
  });
});
