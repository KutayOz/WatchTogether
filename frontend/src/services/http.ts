// Shared response-body handling for the services that talk to /api/*.
//
// A response body is NOT guaranteed to be JSON, on either the failure or the
// success side. The API returns JSON for everything it generates itself, but
// plenty of responses never come from the API at all:
//
//   - nginx's own 502/504 pages and a proxy's 413 rejection are HTML
//   - the platform edge timing out an upstream returns HTML
//   - an SPA/proxy misroute serves index.html — with a 200 — for an /api/* path
//   - a 204 or a truncated response has no body to parse
//
// `response.json()` on any of those throws `SyntaxError: Unexpected token '<'`.
// Every caller in this app renders `err.message` straight into the UI, so an
// unguarded parse means the user sees the parse error while the information
// that would explain the failure — the HTTP status, the content type — is
// destroyed on the way out. We hit exactly that in Phase 0 on a plain-text
// body. Everything below exists to make sure that can't happen again.

/**
 * Parse a response body, returning null instead of throwing when it isn't
 * JSON. The null is deliberately indiscriminate: an HTML body, an empty body
 * and a literal `null` body all collapse to it. Callers here treat all three
 * the same, because none of our endpoints legitimately return `null`.
 */
export const safeJson = async <T>(response: Response): Promise<T | null> => {
  try {
    return (await response.json()) as T;
  } catch {
    return null;
  }
};

type ApiErrorBody = { message?: string };

/**
 * Human-readable stand-in for a status code, used when the body carried no
 * usable message. Covers what an edge or proxy actually emits ahead of the API
 * (413/502/503/504) alongside the ordinary 4xx/5xx the API could return with
 * no body of its own.
 */
export const describeStatus = (status: number): string => {
  switch (status) {
    case 400: return 'bad request';
    case 401: return 'not signed in';
    case 403: return 'not permitted';
    case 404: return 'not found';
    case 408: return 'request timed out';
    case 409: return 'conflict';
    case 413: return 'request too large';
    case 429: return 'too many requests — try again shortly';
    case 500: return 'server error';
    case 502: return 'bad gateway — the server may be restarting';
    case 503: return 'service unavailable — the server may be restarting';
    case 504: return 'gateway timeout';
    default:
      if (status >= 500) return `server error ${status}`;
      if (status >= 400) return `request rejected (${status})`;
      return `unexpected response (${status})`;
  }
};

/** What the server actually sent, for when we expected JSON and didn't get it. */
const describeBody = (response: Response): string => {
  const contentType = response.headers.get('Content-Type')?.split(';')[0].trim();
  return contentType
    ? `the server sent ${contentType} instead of JSON`
    : 'the server sent a response we could not read';
};

/**
 * Build the Error to throw for a failed response. Prefers the API's own
 * `message`; otherwise falls back to the caller's wording plus what the
 * transport said, so the HTTP status reaches the UI even when the body was
 * unparseable. Never throws — an unusable body degrades to the fallback.
 */
export const apiError = async (response: Response, fallback: string): Promise<Error> => {
  const body = await safeJson<ApiErrorBody>(response);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  return new Error(message || `${fallback} (${describeStatus(response.status)})`);
};

/**
 * Parse the body of a *successful* response.
 *
 * Unlike the error path — where an unreadable body only costs us a nicer
 * message — here the parsed value IS the return value, so an unparseable body
 * has to throw. What it must not throw is the raw SyntaxError, whose message
 * (`Unexpected token '<', "<!DOCTYPE "... is not valid JSON`) is meaningless to
 * a user and says nothing about which call failed. The realistic trigger is a
 * proxy or SPA fallback answering an /api/* path with index.html and a 200.
 *
 * Note this guarantees the body parsed, NOT that it matches T — like the plain
 * `response.json()` it replaces, T is an assertion about the API contract
 * rather than a validated shape.
 */
export const readJson = async <T>(response: Response, fallback: string): Promise<T> => {
  const body = await safeJson<T>(response);
  if (body === null) {
    throw new Error(`${fallback} (${describeBody(response)})`);
  }
  return body;
};
