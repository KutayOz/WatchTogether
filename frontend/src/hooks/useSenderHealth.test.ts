import { describe, expect, it } from 'vitest';
import { classifySenderHealth, isSoftwareEncoder, shouldDowngradeCodec } from './useSenderHealth';
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
