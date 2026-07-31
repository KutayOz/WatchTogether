import { fromBase64Url, randomToken, toBase64Url } from "./crypto";

/**
 * Session identifiers and invite tokens.
 *
 * A session id is the entire capability to join: 96 bits of entropy, matching
 * SessionService.cs:554-562. Anyone holding one can join a session with a free
 * slot, which is why they are never guessable and never enumerated.
 */

export function newSessionId(): string {
  return randomToken(12);
}

/**
 * Build a self-describing invite token: `<sessionId>.<secret>`.
 *
 * Embedding the session id lets the Worker route a redemption straight to the
 * owning Durable Object with no lookup table and no database row. That the id
 * is recoverable from the token leaks nothing — the token already grants
 * access to exactly that session.
 */
export function buildInviteToken(sessionId: string, secret: string): string {
  return `${toBase64Url(new TextEncoder().encode(sessionId))}.${secret}`;
}

export function parseInviteToken(
  token: string,
): { sessionId: string; secret: string } | null {
  const separator = token.indexOf(".");
  if (separator <= 0) return null;

  try {
    const sessionId = new TextDecoder().decode(fromBase64Url(token.slice(0, separator)));
    const secret = token.slice(separator + 1);
    if (!sessionId || !secret) return null;

    // Guard against a crafted prefix decoding to something that is not a
    // plausible id before it reaches idFromName.
    if (!/^[A-Za-z0-9_-]{10,32}$/.test(sessionId)) return null;

    return { sessionId, secret };
  } catch {
    return null;
  }
}
