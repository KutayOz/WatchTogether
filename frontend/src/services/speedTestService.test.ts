import { describe, it, expect, afterEach, vi } from 'vitest';
import { speedTestService } from './speedTestService';

// Same regression as api.test.ts, for the one service that talks to /api/*
// without going through api.ts.
//
// runTest() is the app's most exposed call in this respect: it POSTs a 256KB
// binary payload against the endpoint's 512KB [RequestSizeLimit], so any proxy
// in front of the API with a stricter body cap rejects it with its own HTML
// 413 — a failure the API never sees and never formats as JSON. Before the
// fix, the error path threw a fixed 'Speed test failed' that hid the status,
// and the success path called response.json() unguarded.

const PROXY_413 =
  '<html><head><title>413 Request Entity Too Large</title></head><body><h1>413</h1></body></html>';

/**
 * Make the next fetch resolve with a canned response. Pass `null` for a
 * genuinely bodiless response — the Response constructor auto-stamps
 * `Content-Type: text/plain` onto a '' body.
 */
const respondWith = (status: number, body: string | null, contentType?: string) => {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () =>
        new Response(body, {
          status,
          headers: contentType ? { 'Content-Type': contentType } : {},
        }),
    ),
  );
};

const okBody = (overrides: Record<string, unknown> = {}) =>
  JSON.stringify({
    uploadSpeedMbps: 42.5,
    recommendedQuality: 'high',
    supportedQualities: { auto: true, low: true, high: true },
    ...overrides,
  });

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('speedTestService error handling', () => {
  it.each([
    ['an HTML 413 from a proxy body cap', 413, PROXY_413, 'text/html', 'request too large'],
    ['an HTML 502 from the edge', 502, '<html>bad gateway</html>', 'text/html', 'bad gateway — the server may be restarting'],
    ['a plain-text 404', 404, 'not found', 'text/plain', 'not found'],
    ['an empty 500', 500, null, undefined, 'server error'],
  ])('surfaces the status for %s', async (_name, status, body, contentType, expected) => {
    respondWith(status, body, contentType);

    const error = await speedTestService.runTest().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe(`Speed test failed (${expected})`);
  });

  it("prefers the API's own message when the body is JSON", async () => {
    respondWith(429, JSON.stringify({ message: 'Speed test rate limit reached' }), 'application/json');
    await expect(speedTestService.runTest()).rejects.toThrow('Speed test rate limit reached');
  });
});

describe('speedTestService success handling', () => {
  it.each([
    ['index.html from an SPA fallback', '<!DOCTYPE html><html><body></body></html>', 'text/html', 'the server sent text/html instead of JSON'],
    ['an empty body', null, undefined, 'the server sent a response we could not read'],
  ])('rejects readably when a 200 carries %s', async (_name, body, contentType, expected) => {
    respondWith(200, body, contentType);

    const error = await speedTestService.runTest().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe(`Speed test failed (${expected})`);
  });

  it('returns the server-measured result on a well-formed 200', async () => {
    respondWith(200, okBody(), 'application/json');

    const result = await speedTestService.runTest();

    expect(result.uploadSpeedMbps).toBe(42.5);
    expect(result.recommendedQuality).toBe('high');
    expect(result.supportedQualities).toEqual({ auto: true, low: true, high: true });
    expect(result.timestamp).toBeTypeOf('number');
  });

  // SpeedTestUploadResponse types uploadSpeedMbps as required, but that's an
  // assertion about the contract rather than a validated shape — readJson only
  // guarantees the body parsed. The pre-existing client-side fallback is what
  // actually covers a missing value, so pin it.
  it('falls back to the client-side measurement when the server omits a speed', async () => {
    respondWith(200, JSON.stringify({ recommendedQuality: 'auto', supportedQualities: { auto: true } }), 'application/json');

    const result = await speedTestService.runTest();

    expect(result.uploadSpeedMbps).toBeGreaterThan(0);
    expect(Number.isFinite(result.uploadSpeedMbps)).toBe(true);
  });
});
