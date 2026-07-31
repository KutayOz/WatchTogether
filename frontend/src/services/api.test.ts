import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from './api';

// Regression tests for unguarded error-body parsing.
//
// Every api.* method used to call `await response.json()` on a failed response
// (or, in about half the cases, discard the body entirely). The API always
// returns `{ message }` for /api/* failures it generates itself — but a large
// class of failures never reaches it: nginx's own 502/504 pages, the platform
// edge timing out an upstream, a proxy rejecting an oversized body, a
// plain-text "not found". Those bodies are HTML or text, and `response.json()`
// on them throws `SyntaxError: Unexpected token '<'`.
//
// The SyntaxError then propagated *in place of* the real failure: the HTTP
// status was destroyed on the way out and the user saw a parse error. We hit
// exactly that in Phase 0 on a plain-text body. safeJson() now swallows the
// parse failure so the status always survives.
//
// These tests drive api.createSession() because the assertions are about the
// shared error path, not any one endpoint — every method routes through the
// same apiError() helper.

// A representative edge error page: served with an HTML content-type and a
// body that fails JSON.parse on the very first character.
const EDGE_HTML =
  '<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body><h1>Error 502</h1></body></html>';

/** Make the next fetch resolve with a canned response. */
const respondWith = (status: number, body: string, contentType?: string) => {
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

/** Minimal in-memory Storage stand-in — clearAuthData() runs on the 401 path. */
const memoryStorage = (): Storage => {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
};

beforeEach(() => {
  vi.stubGlobal('window', { location: { pathname: '/lobby', href: '/lobby' } });
  vi.stubGlobal('localStorage', memoryStorage());
  vi.stubGlobal('sessionStorage', memoryStorage());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('api error handling — non-JSON bodies', () => {
  // The bug itself: without safeJson, each of these throws SyntaxError and the
  // status is lost. The assertion is deliberately two-part — the message must
  // name the status, AND the error must not be the parse error in disguise.
  it.each([
    ['HTML 502 from the edge', 502, EDGE_HTML, 'text/html', 'bad gateway — the server may be restarting'],
    ['plain-text 404 (the Phase 0 case)', 404, 'not found', 'text/plain', 'not found'],
    ['HTML 504 gateway timeout', 504, '<html>gateway timeout</html>', 'text/html', 'gateway timeout'],
    ['HTML 503 during a restart', 503, '<html>no healthy upstream</html>', 'text/html', 'service unavailable — the server may be restarting'],
    ['413 from a proxy body limit', 413, '<html>413 Request Entity Too Large</html>', 'text/html', 'request too large'],
    ['empty body', 500, '', undefined, 'server error'],
  ])('surfaces the status for %s', async (_name, status, body, contentType, expected) => {
    respondWith(status, body, contentType);

    const error = await api.createSession().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe(`Failed to create session (${expected})`);
  });

  it('falls back to a generic description for unmapped statuses', async () => {
    respondWith(521, '<html>origin is unreachable</html>', 'text/html');
    await expect(api.createSession()).rejects.toThrow('Failed to create session (server error 521)');

    respondWith(451, 'blocked', 'text/plain');
    await expect(api.createSession()).rejects.toThrow('Failed to create session (request rejected (451))');
  });

  // Guards the premise of the fix: if Response.json() ever stopped throwing on
  // HTML, these tests would pass for the wrong reason.
  it('confirms an unguarded response.json() really does throw on the same body', async () => {
    respondWith(502, EDGE_HTML, 'text/html');
    const response = await fetch('/api/session/create');
    await expect(response.json()).rejects.toBeInstanceOf(SyntaxError);
  });
});

describe('api error handling — JSON bodies', () => {
  it("prefers the API's own message", async () => {
    respondWith(400, JSON.stringify({ message: 'Session limit reached' }), 'application/json');
    await expect(api.createSession()).rejects.toThrow('Session limit reached');
  });

  // Well-formed JSON that simply isn't the shape we expect must not produce
  // "undefined" or "[object Object]" in the UI.
  it.each([
    ['no message field', '{"error":"nope"}', 'Failed to create session (bad request)'],
    ['a non-string message', '{"message":123}', 'Failed to create session (bad request)'],
    ['a whitespace-only message', '{"message":"   "}', 'Failed to create session (bad request)'],
    ['a top-level array', '[1,2,3]', 'Failed to create session (bad request)'],
    ['a bare string', '"plain"', 'Failed to create session (bad request)'],
  ])('falls back when the body has %s', async (_name, body, expected) => {
    respondWith(400, body, 'application/json');
    await expect(api.createSession()).rejects.toThrow(expected);
  });
});

describe('api error handling — untouched behaviour', () => {
  it('leaves the success path alone', async () => {
    respondWith(200, JSON.stringify({ sessionId: 'abc' }), 'application/json');
    await expect(api.createSession()).resolves.toEqual({ sessionId: 'abc' });
  });

  // authFetch short-circuits on 401 before the body is ever read, so an HTML
  // 401 from the edge must still redirect rather than surface a status message.
  it('still redirects to login on 401, even with an HTML body', async () => {
    respondWith(401, EDGE_HTML, 'text/html');

    await expect(api.createSession()).rejects.toThrow('Session expired. Please sign in again.');
    expect(window.location.href).toBe('/login');
  });

  it('swallows logout failures so a bad gateway cannot strand the user', async () => {
    respondWith(502, EDGE_HTML, 'text/html');
    await expect(api.logout()).resolves.toBeUndefined();
  });
});
