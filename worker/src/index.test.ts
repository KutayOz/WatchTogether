import { createScheduledController, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "./db/testSchema";
import { createUser, getUserById } from "./db/users";
import { createInvitationLink } from "./db/invitationLinks";
import { revokeToken } from "./db/revokedTokens";
import { sha256Hex } from "./lib/crypto";
import worker from "./index";

/**
 * The nightly cron.
 *
 * Tested through the exported handler rather than by poking `wrangler dev
 * --test-scheduled`, which cannot reach it at all: `/__scheduled` does not
 * match `run_worker_first = ["/api/*"]`, so the asset layer answers it with the
 * SPA and returns a 200 that looks exactly like success. Nothing about the cron
 * runs. Here the handler is called directly, against real D1.
 *
 * What it has to get right is the *negative* half — an expiry sweep that also
 * takes live rows is worse than no sweep, because it silently signs everyone
 * out and hands back invite slots that are still in use. So every case below
 * seeds one expired row and one live one.
 */
const db = env.DB;

beforeEach(async () => {
  await resetDatabase(db);
});

/**
 * No ExecutionContext: the handler awaits its own work rather than deferring it
 * to waitUntil, so there is nothing left running once this resolves.
 */
async function runCron(): Promise<void> {
  await worker.scheduled(createScheduledController(), env);
}

async function seedUser(username: string) {
  const created = await createUser(db, { username, usernameLower: username });
  if (!created.ok) throw new Error("seed failed");
  return created.user;
}

describe("nightly cron", () => {
  it("drops deny-list entries for tokens that have expired anyway, and keeps the rest", async () => {
    const user = await seedUser("sweep");
    const nowSeconds = Math.floor(Date.now() / 1000);
    await revokeToken(db, "expired-jti", user.id, nowSeconds - 60);
    await revokeToken(db, "live-jti", user.id, nowSeconds + 3600);

    await runCron();

    const { results } = await db.prepare("SELECT jti FROM revoked_tokens").all<{ jti: string }>();
    expect(results.map((r) => r.jti)).toEqual(["live-jti"]);
  });

  /**
   * The invite quota is the only thing limiting who can join, so a slot that
   * leaks stays leaked: D1 has no TTL index and nothing else ever recounts.
   */
  it("returns the slot held by an expired, unused invite link", async () => {
    const user = await seedUser("tickets");
    const expired = await createInvitationLink(db, user.id, 5);
    const live = await createInvitationLink(db, user.id, 5);
    if (!expired.ok || !live.ok) throw new Error("seed failed");

    expect((await getUserById(db, user.id))?.active_link_count).toBe(2);
    // Age exactly one of them, found by its own token's lookup hash.
    await db
      .prepare("UPDATE invitation_links SET expires_at = ? WHERE token_lookup = ?")
      .bind(Date.now() - 1, await sha256Hex(expired.token))
      .run();

    await runCron();

    expect((await getUserById(db, user.id))?.active_link_count).toBe(1);
    const open = await db
      .prepare("SELECT COUNT(*) AS n FROM invitation_links WHERE ticket_returned = 0")
      .first<{ n: number }>();
    expect(open?.n).toBe(1);
  });

  /**
   * Cron delivery is at-least-once, and a retry that decrements the counter a
   * second time would give the user back slots they never spent.
   */
  it("is idempotent — a second run changes nothing", async () => {
    const user = await seedUser("twice");
    const link = await createInvitationLink(db, user.id, 5);
    if (!link.ok) throw new Error("seed failed");
    await db.prepare("UPDATE invitation_links SET expires_at = ?").bind(Date.now() - 1).run();

    await runCron();
    const afterFirst = (await getUserById(db, user.id))?.active_link_count;
    await runCron();

    expect(afterFirst).toBe(0);
    expect((await getUserById(db, user.id))?.active_link_count).toBe(0);
  });

  it("runs clean against an empty database", async () => {
    await expect(runCron()).resolves.toBeUndefined();
  });
});
