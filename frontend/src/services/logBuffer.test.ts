import { beforeEach, describe, expect, it } from 'vitest';
import { LOG_BUFFER_SIZE, logBuffer } from './logBuffer';

/**
 * The lines this app already writes are the ones a support case needs — the ICE
 * candidate dump on a TCP-relayed path, the codec fallback, a setParameters the
 * browser refused. They existed only for someone who had DevTools open before
 * the problem started, which is nobody.
 */
describe('logBuffer', () => {
  beforeEach(() => logBuffer.clear());

  it('joins the arguments the way console would show them', () => {
    logBuffer.push('warn', ['[WebRTC] codec fallback', 'libvpx-vp9'], 1000);
    expect(logBuffer.snapshot()[0].text).toBe('[WebRTC] codec fallback libvpx-vp9');
  });

  it('keeps an Error readable instead of stringifying it to {}', () => {
    // JSON.stringify(new Error('x')) is '{}', which is the single most common
    // way a log line ends up saying nothing at all.
    logBuffer.push('error', ['failed:', new TypeError('bad codec')], 1000);
    expect(logBuffer.snapshot()[0].text).toBe('failed: TypeError: bad codec');
  });

  it('bounds an object so one stats dump cannot drown the line that matters', () => {
    logBuffer.push('debug', [{ blob: 'x'.repeat(1000) }], 1000);
    const text = logBuffer.snapshot()[0].text;
    expect(text.length).toBeLessThan(320);
    expect(text.endsWith('…')).toBe(true);
  });

  it('does not throw on something that cannot be serialised', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => logBuffer.push('debug', [circular], 1000)).not.toThrow();
    expect(logBuffer.snapshot()[0].text).toBe('[unserialisable]');
  });

  it('drops the oldest lines rather than growing for the length of a call', () => {
    // A session runs for hours. An unbounded log is a leak with a nice name.
    for (let i = 0; i < LOG_BUFFER_SIZE + 25; i++) {
      logBuffer.push('debug', [`line ${i}`], i);
    }
    const held = logBuffer.snapshot();
    expect(held).toHaveLength(LOG_BUFFER_SIZE);
    expect(held[0].text).toBe('line 25');
    expect(held[held.length - 1].text).toBe(`line ${LOG_BUFFER_SIZE + 24}`);
  });

  it('hands out a copy, so a report cannot be mutated by later logging', () => {
    logBuffer.push('warn', ['first'], 1000);
    const taken = logBuffer.snapshot();
    logBuffer.push('warn', ['second'], 2000);
    expect(taken).toHaveLength(1);
  });
});
