import { describe, expect, it } from 'vitest';
import {
  classifySenderHealth,
  isSoftwareEncoder,
  shouldDowngradeCodec,
  sourceIsIdle,
} from './useSenderHealth';
import type { OutboundScreenStats } from '../types';

/**
 * The control loop's only input, and it had no test.
 *
 * This is the function that decided the reported collapse was 'unknown' — and
 * 'unknown' means "hold" to both consumers, so the budget froze and the ladder
 * reset its good-poll counter on every poll. The stream was not sliding towards
 * the floor; it was parked there with nothing able to move it.
 */
function stats(over: Partial<OutboundScreenStats> = {}): OutboundScreenStats {
  return {
    frameWidth: 640,
    frameHeight: 360,
    framesPerSecond: 24,
    targetBitrate: 200_000,
    qualityLimitationReason: 'none',
    encoderImplementation: 'libvpx-vp9',
    totalEncodeTime: 1,
    framesEncoded: 100,
    ...over,
  };
}

describe('classifySenderHealth', () => {
  it('calls the reported collapse what it is: our own ceiling binding', () => {
    // The exact numbers off the overlay: sending 0.03 Mbps against a 25 kbps
    // ceiling, limited by bandwidth. ratio = 1.2, so it is neither under-served
    // (needs < 0.85) nor satisfied (needs reason 'none'). It used to fall
    // through to 'unknown'. targetBitrate is min(our ceiling, the estimator's
    // allocation), so sitting AT the ceiling proves the estimator has at least
    // that much — which makes this a reason to raise, not to hold.
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'bandwidth', targetBitrate: 30_000 }),
        25_000,
      ),
    ).toBe('self-limited');
  });

  it('reports a genuine shortage as under-served', () => {
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'bandwidth', targetBitrate: 500_000 }),
        2_000_000,
      ),
    ).toBe('under-served');
  });

  it('reports an unlimited encoder at its ceiling as satisfied', () => {
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'none', targetBitrate: 1_000_000 }),
        1_000_000,
      ),
    ).toBe('satisfied');
  });

  it('lets CPU win over any bandwidth reading', () => {
    // The one verdict whose correct response differs in kind: fewer bits do not
    // buy CPU. It must never be masked by a bandwidth number.
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'cpu', targetBitrate: 100_000 }),
        2_000_000,
      ),
    ).toBe('cpu-bound');
  });

  it('leaves no band between under-served and self-limited', () => {
    // The stall that outlived the collapse. 'under-served' needed ratio < 0.85
    // and 'self-limited' needed ratio >= 0.95, so a bandwidth-limited encoder
    // sitting at 0.90 of its ask — precisely where a SUCCESSFUL probe on a busy
    // link lands — was classified 'unknown'. 'unknown' means hold to both
    // consumers, so the budget stopped one step short of the link's real
    // capacity and could never find the rest of it.
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'bandwidth', targetBitrate: 900_000 }),
        1_000_000,
      ),
    ).toBe('self-limited');
    // And the line itself, so the two verdicts stay back to back.
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'bandwidth', targetBitrate: 850_000 }),
        1_000_000,
      ),
    ).toBe('self-limited');
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'bandwidth', targetBitrate: 849_000 }),
        1_000_000,
      ),
    ).toBe('under-served');
  });

  it('treats an unlimited encoder that is under-spending as no news', () => {
    // Nothing is holding it back and it is still not spending its ceiling, so
    // the content simply does not need the bits. That is a statement about the
    // picture, not about the link — raising would buy nothing and lowering
    // would be answering a question nobody asked.
    expect(
      classifySenderHealth(
        stats({ qualityLimitationReason: 'none', targetBitrate: 400_000 }),
        1_000_000,
      ),
    ).toBe('unknown');
  });

  it('has no opinion where the browser will not say', () => {
    // Firefox and Safari do not publish targetBitrate. A guess here would drive
    // the whole loop.
    expect(classifySenderHealth(stats({ targetBitrate: null }), 1_000_000)).toBe('unknown');
    expect(classifySenderHealth(null, 1_000_000)).toBe('unknown');
    expect(classifySenderHealth(stats(), 0)).toBe('unknown');
  });
});

/**
 * The second of the two answers this file's own SenderHealth comment names for
 * a CPU-bound encoder — "a smaller resolution or a cheaper codec". The first
 * lives in encodeCapacity; this decides whether the second is warranted.
 */
describe('isSoftwareEncoder', () => {
  it('recognises the names Chrome uses for its own encoders', () => {
    expect(isSoftwareEncoder('libvpx')).toBe(true);
    expect(isSoftwareEncoder('libvpx-vp9')).toBe(true);
    expect(isSoftwareEncoder('libaom')).toBe(true);
    expect(isSoftwareEncoder('OpenH264')).toBe(true);
  });

  it('searches rather than compares, because simulcast wraps the name', () => {
    expect(isSoftwareEncoder('SimulcastEncoderAdapter (libvpx, libvpx)')).toBe(true);
  });

  it('leaves hardware alone', () => {
    expect(isSoftwareEncoder('ExternalEncoder')).toBe(false);
    expect(isSoftwareEncoder('VideoToolbox')).toBe(false);
    expect(isSoftwareEncoder('MediaFoundationVideoEncodeAccelerator')).toBe(false);
  });

  it('treats silence as hardware, not as software', () => {
    // A codec downgrade costs the viewer a decoder teardown and a keyframe.
    // Firefox and Safari publish nothing here and should get the pixel bound,
    // which costs nothing.
    expect(isSoftwareEncoder(null)).toBe(false);
    expect(isSoftwareEncoder('')).toBe(false);
  });
});

describe('shouldDowngradeCodec', () => {
  it('fires only when the encoder is BOTH CPU-bound and in software', () => {
    const software = stats({ encoderImplementation: 'libvpx-vp9' });
    expect(shouldDowngradeCodec(software, 'cpu-bound')).toBe(true);
    expect(shouldDowngradeCodec(software, 'under-served')).toBe(false);
    expect(shouldDowngradeCodec(software, 'satisfied')).toBe(false);
  });

  it('leaves a hardware encoder on the codec it was given', () => {
    // A hardware encoder that is CPU-bound is telling us about the machine, not
    // about the codec, and swapping would spend a keyframe to learn nothing.
    expect(shouldDowngradeCodec(stats({ encoderImplementation: 'ExternalEncoder' }), 'cpu-bound'))
      .toBe(false);
  });

  it('has nothing to say without a sample', () => {
    expect(shouldDowngradeCodec(null, 'cpu-bound')).toBe(false);
  });
});

describe('sourceIsIdle', () => {
  it('recognises a still screen from the captured session', () => {
    // The row that started this: asked 640x360@30, sending 1280x678@1. Nearly
    // four times the pixels at a thirtieth of the frames — a shape no amount of
    // bandwidth pressure can produce under 'maintain-framerate', because a
    // starved encoder spends resolution before it spends frames.
    expect(
      sourceIsIdle(
        stats({ frameWidth: 1280, frameHeight: 678, framesPerSecond: 1 }),
        640 * 360,
        30,
      ),
    ).toBe(true);
  });

  it('leaves a healthy under-run alone', () => {
    // 23 of 30 is the same session once the video resumed, and it is what an
    // encoder does on a good day. The threshold has to sit well clear of it.
    expect(
      sourceIsIdle(
        stats({ frameWidth: 1280, frameHeight: 720, framesPerSecond: 23 }),
        1280 * 720,
        30,
      ),
    ).toBe(false);
  });

  it('leaves content that is simply slower than the ask alone', () => {
    // 28 fps of a 60 fps ask: `games` mode over content that was never 60 fps.
    // This verdict freezes the budget, so calling it here would strand a real
    // share with nothing able to adapt for the rest of the session.
    expect(
      sourceIsIdle(
        stats({ frameWidth: 1280, frameHeight: 720, framesPerSecond: 28 }),
        1280 * 720,
        60,
      ),
    ).toBe(false);
  });

  it('does not eat a genuine shortage', () => {
    // Small picture AND few frames is an encoder that has already spent its
    // resolution and is now spending frames — a real shortage, and it has to
    // keep reaching the branches that answer one.
    expect(
      sourceIsIdle(
        stats({ frameWidth: 640, frameHeight: 360, framesPerSecond: 2 }),
        1920 * 1080,
        30,
      ),
    ).toBe(false);
  });

  it('tolerates the capturer letterboxing the box we asked for', () => {
    // 640x360 asked, 640x338 captured. That 6% is the source's aspect ratio,
    // not the encoder giving up, and a strict comparison would miss every
    // still screen on a wide display.
    expect(
      sourceIsIdle(
        stats({ frameWidth: 640, frameHeight: 338, framesPerSecond: 1 }),
        640 * 360,
        30,
      ),
    ).toBe(true);
  });

  it('says nothing when the browser publishes no frame rate', () => {
    // Firefox and Safari. Declaring a source idle on no evidence would freeze
    // their budget for the whole session; falling through to the bitrate ratio
    // is what they should get.
    expect(sourceIsIdle(stats({ framesPerSecond: null }), 640 * 360, 30)).toBe(false);
  });

  it('says nothing without an ask to measure against', () => {
    expect(sourceIsIdle(stats({ framesPerSecond: 1 }), null, 30)).toBe(false);
    expect(sourceIsIdle(stats({ framesPerSecond: 1 }), 640 * 360, null)).toBe(false);
    expect(sourceIsIdle(null, 640 * 360, 30)).toBe(false);
  });
});

describe('classifySenderHealth and a still screen', () => {
  it('reads a motionless capture as source-idle, not as a shortage', () => {
    // Before this verdict existed the same sample classified 'under-served'
    // (reason bandwidth, ratio 0.73) and nextBudget answered it by cutting the
    // budget 0.85x — every poll, for as long as nobody touched the window.
    const still = stats({
      frameWidth: 640,
      frameHeight: 338,
      framesPerSecond: 1,
      qualityLimitationReason: 'bandwidth',
      targetBitrate: 300_000,
    });
    expect(classifySenderHealth(still, 410_000)).toBe('under-served');
    expect(classifySenderHealth(still, 410_000, 640 * 360, 30)).toBe('source-idle');
  });

  it('still puts CPU first', () => {
    // The one verdict whose correct answer is different in kind. A CPU-bound
    // encoder that is also producing few frames needs the codec and pixel
    // remedies, not a hold.
    expect(
      classifySenderHealth(
        stats({ framesPerSecond: 1, qualityLimitationReason: 'cpu' }),
        410_000,
        640 * 360,
        30,
      ),
    ).toBe('cpu-bound');
  });

  it('changes nothing for callers that pass no geometry', () => {
    // The parameters are optional so the classifier keeps working for anyone
    // who only has a bitrate — and so this change cannot alter a verdict it
    // was not given the evidence to alter.
    const sample = stats({ framesPerSecond: 1, qualityLimitationReason: 'none', targetBitrate: 400_000 });
    expect(classifySenderHealth(sample, 400_000)).toBe('satisfied');
  });
});
