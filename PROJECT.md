<!-- Run the Check under ## Now before trusting anything below it.
     Decided / Rejected / Traps are append-only — never reworded, never deleted.
     Now / Needs me / Unverified are rewritten in the change that makes them wrong.
     No checkboxes: a finished thing is a quoted command and what it printed.
     No ids, tokens, keys or account URLs — this repo may be public. -->

# WatchTogether — two-person video call with screen share and synced YouTube. Invite-only, passkey sign-in.

MODE: ship
Plan: none — the migration plan was never copied into the repo (see Needs me)

## Now
Mine: PR #14 is MERGEABLE but BEHIND main. Update the branch, then merge.
Check: gh pr view 14 --json mergeStateStatus -> {"mergeStateStatus":"CLEAN"}

## Needs me
- Copy the migration plan from ~/.claude/plans/ into docs/PLAN.md and name it on the Plan: line
  above. It is the only record of why the eight phases were sequenced as they were. (inferred)
- Register a second passkey from another device in Settings. One account, one credential, and no
  recovery path if that authenticator is lost. (inferred from schema + single-user state)

## Decided
- Cloudflare Workers + Durable Objects + D1, one Worker serving SPA and /api from one origin —
  free tier, and static assets never invoke the Worker so they cost nothing. (from README)
- Passkeys only, no passwords — BCrypt work factor 12 costs ~400ms against a 10ms CPU budget, so
  passwords are not slow here, they are impossible. (from README)
- Identity is username#discriminator, not email. Email and all verification machinery deleted.
  (from README, migration 0001_init.sql)
- High-frequency presence (cursors, typing, reactions, video sync) rides the WebRTC DataChannel,
  not the socket — every inbound WebSocket message bills a Durable Object request, and 10Hz
  cursors alone would spend a third of the daily free budget on one session. (from README)
- SQLite-backed Durable Objects (new_sqlite_classes) — KV-backed are paid-only. (from wrangler.toml)
- The screen share outranks the camera for uplink; the camera is capped. (from PR #15, #16)
- Terms gate lives at the app level, not on the two account-creation screens. (from PR #13)

## Rejected
- Fly.io — the apps were deleted and both domains stopped resolving; this migration exists
  because of it. (from README History section)
- MongoDB Atlas — dropped with the .NET backend; no data migration, started clean. (from README)
- Railway — outside the standing cost ceiling. (from memory file, not the repo)
- Google sign-in, email verification, demo requests — deleted with the rewrite. (from README)
- A server-measured speed test — on Workers it measures client-to-edge, so it would report an
  enormous uplink for everyone and unlock every preset, worst for the slowest links. (from PR #11)
- TDD as a requirement — evidence on test-first vs test-after is inconclusive; the defect is
  direction, not order. (from this session, not the repo)

## Traps
- `wrangler dev --test-scheduled` returns 200 and runs no cron code at all — the asset layer
  answers it. A green that means nothing. (from DEPLOYMENT.md)
- A missing asset returns 200 with index.html, not 404 — single-page-application fallback. Probing
  a stale chunk hash looks like a broken cache rule. (from DEPLOYMENT.md)
- `new_sqlite_classes`, not `new_classes` — the most common silent free-plan deploy failure.
- Two independent header mechanisms: /api/* in the Worker, everything else in public/_headers.
  Changing one does not change the other. (from DEPLOYMENT.md)
- Changing RP_ID invalidates every registered passkey. (from DEPLOYMENT.md)
- `git push --dry-run` exits 0 against a branch-protected remote — it never reaches the
  server-side hook. A false pass. (from this session)
- Nothing ran the Playwright suite for two phases, so six of twelve specs tested a deleted login
  form. Any suite not wired into CI rots silently. (from .github/workflows/README.md)

## Unverified
- Real-session Durable Object request and GB-s numbers — could not run: needs a sustained
  two-person session and a dashboard read. (from DEPLOYMENT.md)
- Background blur segmenting a real camera feed — could not run: verified only as far as the CSP
  (WASM compiles, both MediaPipe origins load). (from DEPLOYMENT.md)
- Quality clamp firing at a sensible moment on a slow link — could not run: arithmetic is
  unit-tested, nobody has watched it on a degraded connection. Firefox publishes no estimate and
  the hook deliberately has no opinion there. (from DEPLOYMENT.md)
