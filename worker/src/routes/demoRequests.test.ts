import { SELF, env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { resetDatabase } from "../db/testSchema";
import { AUTH_COOKIE } from "../lib/cookies";
import { issueToken } from "../lib/jwt";
import {
  REVIEWED_RETENTION_MS,
  listDemoRequests,
  sweepReviewedDemoRequests,
  type DemoRequestRow,
} from "../db/demoRequests";
import { createRootUser, createUser } from "../db/users";

/**
 * The demo-request queue, end to end against real D1.
 *
 * RL_DEMO is live under Miniflare at five requests per minute per IP — tighter
 * than any other bucket, because this is the one endpoint an anonymous caller
 * can write a row through. Each test takes its own address (own range: 10.5.x,
 * see the note in password.test.ts) and none of them submits more than five
 * times.
 */

const ORIGIN = env.RP_ORIGIN;
const db = env.DB;

let currentIp = 0;

const request = (path: string, init: RequestInit = {}, cookie?: string) =>
  SELF.fetch(`${ORIGIN}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      "CF-Connecting-IP": `10.5.0.${currentIp}`,
      ...(cookie ? { Cookie: cookie } : {}),
      ...(init.headers as Record<string, string>),
    },
  });

const post = (path: string, body?: unknown, cookie?: string) =>
  request(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, cookie);

const submit = (body: unknown) => post("/api/demo-requests", body);

const APPLICANT = { email: "ada@example.com", displayName: "Ada", message: "movie night" };

beforeEach(async () => {
  currentIp++;
  await resetDatabase(db);
});

async function rootCookie(): Promise<string> {
  const root = await createRootUser(db, { username: "root", usernameLower: "root" });
  const { token } = await issueToken(env.JWT_SECRET, root!);
  return `${AUTH_COOKIE}=${token}`;
}

async function regularCookie(): Promise<string> {
  // Root has to exist first — createRootUser only inserts into an empty table.
  await createRootUser(db, { username: "root", usernameLower: "root" });
  const created = await createUser(db, { username: "mallory", usernameLower: "mallory" });
  if (!created.ok) throw new Error("seed failed");
  const { token } = await issueToken(env.JWT_SECRET, created.user);
  return `${AUTH_COOKIE}=${token}`;
}

/** The queue as root sees it. */
async function listAsRoot(cookie: string) {
  const response = await request("/api/admin/demo-requests", {}, cookie);
  expect(response.status).toBe(200);
  return (await response.json<{ requests: { id: string; status: string }[] }>()).requests;
}

async function fileOne(cookie: string) {
  expect((await submit(APPLICANT)).status).toBe(200);
  const [row] = await listAsRoot(cookie);
  return row;
}

describe("filing a request", () => {
  it("stores a pending request for an anonymous caller", async () => {
    const response = await submit(APPLICANT);

    expect(response.status).toBe(200);
    const rows = await listDemoRequests(db);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      email: "ada@example.com",
      display_name: "Ada",
      message: "movie night",
      status: "pending",
    });
  });

  it("keeps the address as typed and compares it folded", async () => {
    expect((await submit({ ...APPLICANT, email: "  Ada@Example.COM " })).status).toBe(200);

    const [row] = await listDemoRequests(db);
    expect(row.email).toBe("Ada@Example.COM");
    expect(row.email_lookup).toBe("ada@example.com");
  });

  it("turns down a body that is not an email", async () => {
    const response = await submit({ ...APPLICANT, email: "ada.example.com" });

    expect(response.status).toBe(400);
    expect(await listDemoRequests(db)).toHaveLength(0);
  });

  it("turns down a note past the cap rather than truncating it", async () => {
    const response = await submit({ ...APPLICANT, message: "x".repeat(501) });

    expect(response.status).toBe(400);
    expect(await listDemoRequests(db)).toHaveLength(0);
  });

  it("answers a repeat from the same address exactly as the first", async () => {
    const first = await submit(APPLICANT);
    const second = await submit({ ...APPLICANT, email: "ADA@example.com" });

    expect(second.status).toBe(first.status);
    expect(await second.json()).toEqual(await first.json());
    // The point of answering identically: the queue does not grow either.
    expect(await listDemoRequests(db)).toHaveLength(1);
  });

  it("lets a rejected applicant apply again", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);

    expect((await post(`/api/admin/demo-requests/${filed.id}/reject`, {}, cookie)).status).toBe(200);
    expect((await submit(APPLICANT)).status).toBe(200);

    const rows = await listDemoRequests(db);
    expect(rows.map((r) => r.status).sort()).toEqual(["pending", "rejected"]);
  });
});

describe("reviewing", () => {
  it("is root's alone", async () => {
    await submit(APPLICANT);

    expect((await request("/api/admin/demo-requests")).status).toBe(401);
    expect((await request("/api/admin/demo-requests", {}, await regularCookie())).status).toBe(403);
  });

  it("mints an invite the applicant can actually redeem", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);

    const approved = await post(`/api/admin/demo-requests/${filed.id}/approve`, {}, cookie);
    expect(approved.status).toBe(200);
    const { inviteUrl } = await approved.json<{ inviteUrl: string }>();

    const token = inviteUrl.slice(inviteUrl.lastIndexOf("/") + 1);
    const validated = await request(`/api/invitation/validate/${token}`);
    expect(await validated.json<{ valid: boolean }>()).toMatchObject({ valid: true });

    expect((await listAsRoot(cookie))[0].status).toBe("approved");
  });

  it("mints a fresh link if root asks again, since the first is shown once", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);

    const first = await post(`/api/admin/demo-requests/${filed.id}/approve`, {}, cookie);
    const second = await post(`/api/admin/demo-requests/${filed.id}/approve`, {}, cookie);

    expect(second.status).toBe(200);
    const urls = [await first.json<{ inviteUrl: string }>(), await second.json<{ inviteUrl: string }>()];
    expect(urls[0].inviteUrl).not.toBe(urls[1].inviteUrl);
  });

  it("records the rejection note and closes the request for good", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);

    const rejected = await post(
      `/api/admin/demo-requests/${filed.id}/reject`,
      { reason: "no idea who this is" },
      cookie,
    );
    expect(rejected.status).toBe(200);

    const [row] = await listDemoRequests(db);
    expect(row).toMatchObject({ status: "rejected", rejection_reason: "no idea who this is" });

    expect((await post(`/api/admin/demo-requests/${filed.id}/reject`, {}, cookie)).status).toBe(409);
    expect((await post(`/api/admin/demo-requests/${filed.id}/approve`, {}, cookie)).status).toBe(409);
  });

  it("answers 404 for a request that is not there", async () => {
    const cookie = await rootCookie();
    expect((await post("/api/admin/demo-requests/nope/approve", {}, cookie)).status).toBe(404);
    expect((await post("/api/admin/demo-requests/nope/reject", {}, cookie)).status).toBe(404);
  });

  it("writes the decision to the audit log, which the sweep never touches", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);
    await post(`/api/admin/demo-requests/${filed.id}/approve`, {}, cookie);

    const audit = await request("/api/admin/audit-log", {}, cookie);
    const { entries } = await audit.json<{ entries: { action: string; target_id: string }[] }>();
    expect(entries[0]).toMatchObject({ action: "DemoRequestApproved", target_id: filed.id });
  });
});

describe("the nightly sweep", () => {
  /** Reach past the routes — there is no way to age a row through the API. */
  const age = (id: string, millis: number) =>
    db.prepare("UPDATE demo_requests SET reviewed_at = ? WHERE id = ?").bind(millis, id).run();

  it("drops requests dealt with long ago and leaves unread ones alone", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);
    await post(`/api/admin/demo-requests/${filed.id}/reject`, {}, cookie);
    await age(filed.id, Date.now() - REVIEWED_RETENTION_MS - 1);

    // A second, still-unread request from a different address.
    expect((await submit({ ...APPLICANT, email: "grace@example.com" })).status).toBe(200);

    expect(await sweepReviewedDemoRequests(db)).toBe(1);

    const left = await listDemoRequests(db);
    expect(left.map((r: DemoRequestRow) => r.email)).toEqual(["grace@example.com"]);
  });

  it("keeps a decision that is still recent", async () => {
    const cookie = await rootCookie();
    const filed = await fileOne(cookie);
    await post(`/api/admin/demo-requests/${filed.id}/reject`, {}, cookie);

    expect(await sweepReviewedDemoRequests(db)).toBe(0);
    expect(await listDemoRequests(db)).toHaveLength(1);
  });
});
