import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { api } from './api';

// Regression tests for unguarded error-body parsing.
//
// Every api.* method used to call `await response.json()` on a failed response
// (or, in about half the cases, discard the body entirely). The API always
// returns `{ message }` for /api/* failures it generates itself — but a large
// class of failures never reaches it: Cloudflare's own error pages, the edge
// rejecting a request before the Worker runs, the asset layer answering an
// unmatched path with index.html, a plain-text "not found". Those bodies are
// HTML or text, and `response.json()`
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

/**
 * Make the next fetch resolve with a canned response. Pass `null` for a
 * genuinely bodiless response — the Response constructor auto-stamps
 * `Content-Type: text/plain` onto a '' body, and rejects a 204 that has one.
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
  // The storages hang off `window` as well as the bare global: authStorage
  // reads window.localStorage explicitly, because modern Node's own
  // experimental localStorage global shadows the DOM one under a test
  // environment and throws on every method.
  const local = memoryStorage();
  const session = memoryStorage();
  vi.stubGlobal('window', {
    location: { pathname: '/lobby', href: '/lobby' },
    localStorage: local,
    sessionStorage: session,
  });
  vi.stubGlobal('localStorage', local);
  vi.stubGlobal('sessionStorage', session);
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
    ['empty body', 500, null, undefined, 'server error'],
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

// The success side has the same exposure for a different reason. A 200 can
// still carry a non-JSON body — the realistic case being a proxy or SPA
// fallback answering an /api/* path with index.html — and there the parsed
// value IS the return value, so it has to throw. What it must not throw is the
// raw SyntaxError, whose message says nothing about which call failed.
describe('api success handling — non-JSON 200s', () => {
  it.each([
    ['index.html from an SPA fallback', '<!DOCTYPE html><html><body><div id="root"></div></body></html>', 'text/html', 'the server sent text/html instead of JSON'],
    ['a truncated body', '{"sessionId":"ab', 'application/json', 'the server sent application/json instead of JSON'],
    ['an empty body', null, undefined, 'the server sent a response we could not read'],
    ['a literal null body', 'null', 'application/json', 'the server sent application/json instead of JSON'],
  ])('rejects readably when a 200 carries %s', async (_name, body, contentType, expected) => {
    respondWith(200, body, contentType);

    const error = await api.createSession().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(SyntaxError);
    expect((error as Error).message).toBe(`Failed to create session (${expected})`);
  });

  // The message has to name the failing call, not just the transport — the
  // whole point is that the user can tell what broke.
  it('carries the calling method’s wording', async () => {
    respondWith(200, '<!DOCTYPE html>', 'text/html');
    await expect(api.getMe()).rejects.toThrow(
      'Failed to fetch current user (the server sent text/html instead of JSON)',
    );

    respondWith(200, '<!DOCTYPE html>', 'text/html');
    await expect(api.getTerms()).rejects.toThrow(
      'Failed to get terms (the server sent text/html instead of JSON)',
    );
  });
});

describe('api error handling — untouched behaviour', () => {
  it('leaves the success path alone', async () => {
    respondWith(200, JSON.stringify({ sessionId: 'abc' }), 'application/json');
    await expect(api.createSession()).resolves.toEqual({ sessionId: 'abc' });
  });

  it('unwraps the admin user list', async () => {
    // The Worker answers `{ users, truncated }` (routes/admin.ts). This test
    // used to feed a bare array and assert it came back — a shape the server
    // has never sent — so it passed while the admin Users tab rendered empty
    // on every load. readJson only proves the body parsed, not that it matches
    // the declared type, so nothing else caught it either.
    respondWith(
      200,
      JSON.stringify({ users: [{ id: '1' }], truncated: false }),
      'application/json',
    );
    await expect(api.getAdminUsers()).resolves.toEqual([{ id: '1' }]);
  });

  // passkeyRemove returns void and never parses a body, so a bodiless 204 —
  // which would throw if it went through readJson — must still resolve.
  it('tolerates a bodiless 204 on a void endpoint', async () => {
    respondWith(204, null);
    await expect(api.passkeyRemove('abc')).resolves.toBeUndefined();
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

/**
 * The one property of the password endpoints this layer is responsible for.
 *
 * api.ts is transport: it has no `password` parameter to accidentally pass a
 * plaintext to, exactly as it has no dependency on @simplewebauthn/browser. The
 * stretching happens in utils/password.ts before anything gets here. A future
 * refactor that "simplifies" these signatures by taking the password directly
 * would send it over the wire, and this is what catches that.
 */
describe('passwords never reach the network in the clear', () => {
  const bodyOf = (fetchMock: ReturnType<typeof vi.fn>): string =>
    String((fetchMock.mock.calls[0]![1] as RequestInit).body);

  const captureFetch = () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ username: 'alice', tag: 'alice#0042' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
    );
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
  };

  const credential = { clientKey: 'A'.repeat(43), clientKdfVersion: 1 };

  it('sends only the derived key on sign-in', async () => {
    const fetchMock = captureFetch();
    await api.passwordLogin('alice#0042', credential);

    const body = bodyOf(fetchMock);
    expect(JSON.parse(body)).toEqual({
      tag: 'alice#0042',
      clientKey: credential.clientKey,
      clientKdfVersion: 1,
    });
    expect(body).not.toContain('password');
  });

  it('sends only the derived key on signup', async () => {
    const fetchMock = captureFetch();
    await api.passwordSignup('invite-token', 'Alice', credential);

    expect(JSON.parse(bodyOf(fetchMock))).toEqual({
      inviteToken: 'invite-token',
      username: 'Alice',
      clientKey: credential.clientKey,
      clientKdfVersion: 1,
    });
  });

  it('sends only the derived key when redeeming a reset link', async () => {
    const fetchMock = captureFetch();
    await api.passwordResetComplete('reset-token', credential);

    expect(JSON.parse(bodyOf(fetchMock))).toEqual({
      token: 'reset-token',
      clientKey: credential.clientKey,
      clientKdfVersion: 1,
    });
  });
});
