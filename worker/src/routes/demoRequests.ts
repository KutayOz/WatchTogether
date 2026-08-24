import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import {
  MAX_EMAIL_LENGTH,
  MAX_MESSAGE_LENGTH,
  MAX_NAME_LENGTH,
  createDemoRequest,
} from "../db/demoRequests";

export const demoRequestRoutes = new Hono<AppEnv>();

/**
 * Deliberately loose. The only thing this catches is a typed-in mistake — a
 * missing @, a trailing comma, a name pasted into the wrong field. Anything
 * stricter starts rejecting addresses that genuinely deliver, and nothing here
 * depends on the address being routable: no mail is sent from this app, root
 * reads it and replies from their own client.
 */
const LOOKS_LIKE_EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

/**
 * File a demo request. Anonymous — the whole point is that the caller has no
 * account and no invite.
 *
 * Every outcome that is not a malformed body answers with the same sentence,
 * including the case where this address already has a request waiting. A
 * distinct "you already applied" would be a free oracle for whether a given
 * address is in the queue, and it is not information the applicant needs: the
 * answer to "did it go through?" is yes either way.
 */
demoRequestRoutes.post("/", async (c) => {
  const body = await c.req.json<{ email?: unknown; displayName?: unknown; message?: unknown }>()
    .catch(() => null);

  if (!body) return c.json({ message: "Expected a JSON body." }, 400);

  const email = typeof body.email === "string" ? body.email.trim() : "";
  const displayName = typeof body.displayName === "string" ? body.displayName.trim() : "";
  const message = typeof body.message === "string" ? body.message.trim() : "";

  if (!email || email.length > MAX_EMAIL_LENGTH || !LOOKS_LIKE_EMAIL.test(email)) {
    return c.json({ message: "Please enter an email address we can reply to." }, 400);
  }
  if (!displayName || displayName.length > MAX_NAME_LENGTH) {
    return c.json({ message: "Please tell us what to call you." }, 400);
  }
  // Truncating silently would quietly discard the end of somebody's sentence,
  // and the form counts characters as they type — arriving over the cap means
  // the counter was bypassed, not that the applicant was unlucky.
  if (message.length > MAX_MESSAGE_LENGTH) {
    return c.json({ message: `Keep the note under ${MAX_MESSAGE_LENGTH} characters.` }, 400);
  }

  await createDemoRequest(c.env.DB, {
    email,
    displayName,
    message,
    ipAddress: c.req.header("CF-Connecting-IP") ?? null,
  });

  return c.json({ message: "Request received. We'll be in touch at that address." });
});
