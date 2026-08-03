import { Hono } from "hono";
import type { AppEnv } from "../middleware/auth";
import { requireAuth } from "../middleware/auth";
import { acceptTerms } from "../db/users";
import { TERMS_CONTENT, TERMS_VERSION } from "../lib/terms";

export const termsRoutes = new Hono<AppEnv>();

termsRoutes.get("/current", (c) =>
  c.json({ version: TERMS_VERSION, content: TERMS_CONTENT }),
);

termsRoutes.post("/accept", requireAuth, async (c) => {
  await acceptTerms(c.env.DB, c.get("user").id, TERMS_VERSION);
  return c.json({ success: true });
});
