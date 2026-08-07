/**
 * The house rules, and who is square with them.
 *
 * Lives in lib/ rather than next to the endpoints because two other routes
 * (/api/auth/me and every passkey login response) have to answer "has this user
 * accepted?", and that answer is only correct if it is measured against the
 * version below. Keeping the text, the version and the predicate in one module
 * is what stops them drifting apart.
 */

/**
 * Bump this when the text below changes materially. Acceptance is recorded
 * against the version, and `hasAcceptedCurrentTerms` compares against it, so
 * raising it re-prompts everyone on their next request.
 */
export const TERMS_VERSION = "1.1";

export const TERMS_CONTENT = `# Terms of Service

**Version ${TERMS_VERSION}**

WatchTogether is a private, invitation-only service for peer-to-peer video
calling and synchronised viewing.

## What the service does

Video, audio and screen sharing travel directly between participants over
WebRTC. They are not relayed through, recorded by, or stored on the server.
When a direct connection cannot be established, media may pass through a TURN
relay, which forwards encrypted traffic without retaining it.

## What is stored

Your username, your passkey public keys, a hash of your password if you set
one, and who invited you. There are no email addresses. Chat messages exist
only for the duration of a session and are never written to disk.

If you set a password, it is scrambled in your browser before it is sent, and
scrambled again before it is stored. The service never receives or keeps the
password itself. Because no email address is held, a forgotten password cannot
be recovered automatically — an administrator has to issue you a reset link.

## Access

Accounts are created by invitation only. Invites are single-use and expire.
Misuse of the service may result in removal without notice.

## No warranty

The service is provided as-is, without warranty of any kind.
`;

/**
 * Whether the user has accepted the terms *currently in force*.
 *
 * The version half is the load-bearing half. Reporting acceptance from
 * `accepted_terms_at !== null` alone — which is what /me and the login
 * responses used to do — means a user who agreed to v1.0 still reads as
 * accepted after v2.0 ships, and the re-prompt the version bump exists to
 * trigger never happens. The `terms_version` column has been written on every
 * acceptance since the schema was created; nothing had ever read it.
 *
 * A NULL `terms_version` on an accepted row (only reachable from data written
 * before the column existed) falls to false, which re-prompts. That is the
 * right way to be wrong.
 */
export function hasAcceptedCurrentTerms(user: {
  accepted_terms_at: number | null;
  terms_version: string | null;
}): boolean {
  return user.accepted_terms_at !== null && user.terms_version === TERMS_VERSION;
}
