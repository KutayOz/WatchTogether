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
            viewport: { width: 2560, height: 1440 },
          },
        },
      },
      {
        t: "share",
        d: {
          status: {
            fps: 24,
            width: 1920,
            height: 1080,
            bps: 2_475_000,
            limitedBy: "cpu",
            encoder: "libvpx-vp9",
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

    it("carries the viewer's viewport through", () => {
      // It did not, for an entire release. The frontend declared its own
      // QualityFeedback with a viewport field, sent it, and validateData —
      // which rebuilds the frame field by field — dropped it on arrival. The
      // sender therefore never learned how big the picture was being drawn, and
      // the whole viewport-aware resolution feature was inert with nothing
      // failing loudly enough to say so.
      const decoded = decodeDataChannelMessage(
        JSON.stringify({
          t: "quality",
          d: { feedback: { ...feedback, viewport: { width: 3024, height: 1964 } } },
        }),
      );
      expect(decoded).toBeTruthy();
      const carried = (decoded!.d as { feedback: { viewport?: unknown } }).feedback.viewport;
      expect(carried).toEqual({ width: 3024, height: 1964 });
    });

    it("treats a malformed viewport as no viewport, not as a bad frame", () => {
      // The consumer already has a conservative answer for "not sent" — it
      // falls back to assuming 1080p — so a bad value takes the same path
      // rather than throwing away a verdict that is otherwise fine.
      for (const viewport of [
        { width: 0, height: 1080 },
        { width: 99_999, height: 1080 },
        { width: "1920", height: 1080 },
        null,
        42,
      ]) {
        const decoded = decodeDataChannelMessage(
          JSON.stringify({ t: "quality", d: { feedback: { ...feedback, viewport } } }),
        );
        expect(decoded).toBeTruthy();
        expect((decoded!.d as { feedback: { viewport?: unknown } }).feedback.viewport)
          .toBeUndefined();
      }
    });

    it("accepts a quality frame from a peer that sends no viewport", () => {
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "quality", d: { feedback } }),
      );
      expect(decoded).toBeTruthy();
      expect((decoded!.d as { feedback: { viewport?: unknown } }).feedback.viewport)
        .toBeUndefined();
    });

    it("carries the size that actually arrived, beside the size it is drawn at", () => {
      // The field without which `level` cannot be read honestly. Every term in
      // calculateQualityScore is about delivery, so a picture collapsed to a
      // stamp but arriving cleanly scores 100 and reports 'excellent' — which
      // is exactly what a captured session shows, with 300x158 on the wire and
      // 2386x1358 of window to paint it into. The sender needs both numbers to
      // see the deficit; it gets neither from the verdict.
      const decoded = decodeDataChannelMessage(
        JSON.stringify({
          t: "quality",
          d: {
            feedback: {
              ...feedback,
              viewport: { width: 2386, height: 1358 },
              picture: { width: 300, height: 158 },
            },
          },
        }),
      );
      expect(decoded).toBeTruthy();
      const carried = decoded!.d as {
        feedback: { viewport?: unknown; picture?: unknown };
      };
      expect(carried.feedback.viewport).toEqual({ width: 2386, height: 1358 });
      expect(carried.feedback.picture).toEqual({ width: 300, height: 158 });
    });

    it("treats a malformed picture as no picture, and keeps the verdict", () => {
      // Same discipline as the viewport beside it: viewerIsStarved is false
      // whenever a term is missing, so a bad value costs a signal rather than a
      // whole quality frame.
      for (const picture of [{ width: 0, height: 158 }, { width: 99_999, height: 158 }, null, 42]) {
        const decoded = decodeDataChannelMessage(
          JSON.stringify({ t: "quality", d: { feedback: { ...feedback, picture } } }),
        );
        expect(decoded).toBeTruthy();
        expect((decoded!.d as { feedback: { picture?: unknown } }).feedback.picture)
          .toBeUndefined();
      }
    });

    it("accepts a quality frame from a peer that sends no picture", () => {
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "quality", d: { feedback } }),
      );
      expect(decoded).toBeTruthy();
      expect((decoded!.d as { feedback: { picture?: unknown } }).feedback.picture)
        .toBeUndefined();
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

  describe("share", () => {
    const status = { fps: 24, width: 1920, height: 1080, bps: 2_475_000 };

    it("rejects an absurd frame rate", () => {
      for (const fps of [0, 121, -24, null]) {
        expect(
          decodeDataChannelMessage(JSON.stringify({ t: "share", d: { status: { ...status, fps } } })),
        ).toBeNull();
      }
    });

    it("rejects a picture size nobody could mean", () => {
      expect(
        decodeDataChannelMessage(
          JSON.stringify({ t: "share", d: { status: { ...status, width: 8 } } }),
        ),
      ).toBeNull();
    });

    it("rejects a negative bitrate", () => {
      expect(
        decodeDataChannelMessage(
          JSON.stringify({ t: "share", d: { status: { ...status, bps: -1 } } }),
        ),
      ).toBeNull();
    });

    it("drops an unrecognised limitation rather than the whole frame", () => {
      // The geometry is still worth having when one optional field is junk.
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "share", d: { status: { ...status, limitedBy: "vibes" } } }),
      );
      expect(decoded).toBeTruthy();
      expect((decoded!.d as { status: { limitedBy?: unknown } }).status.limitedBy).toBeUndefined();
    });

    it("truncates an over-long encoder name rather than rejecting it", () => {
      // It is a browser string that ends up rendered. A long one is a display
      // problem, not a protocol violation.
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "share", d: { status: { ...status, encoder: "x".repeat(200) } } }),
      );
      expect(decoded).toBeTruthy();
      const encoder = (decoded!.d as { status: { encoder?: string } }).status.encoder;
      expect(encoder).toHaveLength(32);
    });

    it("carries what the sender is actually sending, zero included", () => {
      // The receiver's yardstick. Zero is legal here where it is not for `fps`:
      // a capture producing nothing is the exact case this field exists to
      // describe, and rejecting it would leave the far end judging arriving
      // frames against an ask that was never met.
      for (const sentFps of [0, 1, 24]) {
        const decoded = decodeDataChannelMessage(
          JSON.stringify({ t: "share", d: { status: { ...status, sentFps } } }),
        );
        expect(decoded).toBeTruthy();
        expect((decoded!.d as { status: { sentFps?: number } }).status.sentFps).toBe(sentFps);
      }
    });

    it("drops a junk sentFps rather than the whole frame", () => {
      // Additive and optional: a peer that cannot measure it must still be able
      // to say everything else, and so must one on an older build.
      for (const sentFps of [-1, 121, "fast", null]) {
        const decoded = decodeDataChannelMessage(
          JSON.stringify({ t: "share", d: { status: { ...status, sentFps } } }),
        );
        expect(decoded).toBeTruthy();
        expect(
          (decoded!.d as { status: { sentFps?: number } }).status.sentFps,
        ).toBeUndefined();
      }
    });

    it("omits sentFps entirely when the peer never sent one", () => {
      const decoded = decodeDataChannelMessage(
        JSON.stringify({ t: "share", d: { status } }),
      );
      expect(decoded).toBeTruthy();
      expect("sentFps" in (decoded!.d as { status: object }).status).toBe(false);
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
    for (const type of ["typing", "reaction", "videoSync", "quality", "share"] as const) {
      expect(channelFor(type)).toBe("control");
    }
  });

  it("gives the two channels distinct ids, since both ends create them blind", () => {
    expect(FAST_CHANNEL.id).not.toBe(CONTROL_CHANNEL.id);
    expect(FAST_CHANNEL.label).not.toBe(CONTROL_CHANNEL.label);
  });
});
