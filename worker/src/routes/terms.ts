import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { acceptTerms } from "../db/users";

export const termsRoutes = new Hono<AppEnv>();

/**
 * Bump this when the text below changes materially. Acceptance is recorded
 * against the version, so raising it re-prompts everyone.
 */
export const TERMS_VERSION = "1.0";

const TERMS_CONTENT = `# Terms of Service

**Version ${TERMS_VERSION}**

WatchTogether is a private, invitation-only service for peer-to-peer video
calling and synchronised viewing.

## What the service does

Video, audio and screen sharing travel directly between participants over
WebRTC. They are not relayed through, recorded by, or stored on the server.
When a direct connection cannot be established, media may pass through a TURN
relay, which forwards encrypted traffic without retaining it.

## What is stored

Your username, your passkey public keys, and who invited you. There are no
passwords and no email addresses. Chat messages exist only for the duration of
a session and are never written to disk.

## Access

Accounts are created by invitation only. Invites are single-use and expire.
Misuse of the service may result in removal without notice.

## No warranty

The service is provided as-is, without warranty of any kind.
`;

termsRoutes.get("/current", (c) =>
  c.json({ version: TERMS_VERSION, content: TERMS_CONTENT }),
);

termsRoutes.post("/accept", requireAuth, async (c) => {
  await acceptTerms(c.env.DB, c.get("user").id, TERMS_VERSION);
  return c.json({ success: true });
});
