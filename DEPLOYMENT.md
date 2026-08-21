# Deployment

Runbook for the Cloudflare deployment. Last updated 2026-07-31.

## What exists

| What | Value |
|---|---|
| Live | https://app.watchtogether.workers.dev |
| Health | https://app.watchtogether.workers.dev/api/health |
| Worker | `app`, on the account subdomain `watchtogether` |
| D1 | `watchtogether` — `0372f4d6-afce-48f2-921c-f9fc6d3a164f`, region EEUR |
| Durable Objects | `SessionRoom`, `AuthChallenge` — both SQLite-backed |
| Cron | `17 4 * * *` — nightly housekeeping |
| TURN | Cloudflare Realtime, app `watchtogether-workers` |
| CI/CD | GitHub Actions — see [.github/workflows/README.md](.github/workflows/README.md) |

Cost: **$0.00**. Two accounts, Cloudflare and GitHub, both on free plans. There
is no third-party database, mail provider or host.

The hostname is `<worker>.<account-subdomain>.workers.dev`, not
`<worker>.workers.dev` — both labels belong to us, and they were picked to read
together.

## Deploying

Push to `main`. `deploy.yml` runs every check, builds the SPA, applies D1
migrations, then deploys.

By hand, if Actions is unavailable:

```bash
cd frontend && npm ci && npm run build
cd ../worker && npm ci && npm run db:migrate:remote && npm run deploy
```

**Build the SPA first.** `wrangler.toml` points `[assets]` at
`../frontend/dist`, so deploying the Worker against a stale `dist/` ships
yesterday's frontend with today's backend, and nothing warns you.

## Secrets

Four, all on the Worker. Set them yourself — `wrangler secret put` prompts, so
the value never lands in shell history:

```bash
cd worker
npx wrangler secret put JWT_SECRET
```

| Name | What it is |
|---|---|
| `JWT_SECRET` | HS256 signing key. `openssl rand -base64 48`. Rotating it signs everyone out, which is the intended blast radius. |
| `SETUP_SECRET` | Gates the first-run root bootstrap. Only usable while the users table is empty. |
| `CLOUDFLARE_TURN_KEY_ID` | Realtime TURN key id. |
| `CLOUDFLARE_TURN_API_TOKEN` | Mints short-lived ICE credentials per request. |

`npx wrangler secret list` prints the names, never the values.

Both TURN secrets are optional: unset, the app serves STUN only, which works for
most peers and fails behind symmetric NAT. Cloudflare shows a TURN token exactly
once — lose it and the only path forward is deleting the TURN app and making a
new one.

Non-secret config lives in `[vars]` in `wrangler.toml`, and `worker/.dev.vars`
(gitignored) overrides it locally.

GitHub Actions needs two repository secrets of its own,
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` — see the workflows README.

## Operating it

### Logs

```bash
cd worker && npx wrangler tail
```

Live only; Workers do not retain logs on the free plan. `npx wrangler tail --status error` filters to failures.

### Rolling back

```bash
npx wrangler deployments list
npx wrangler rollback <version-id>
```

Every version is retained and the id is printed in the Actions run summary.

Rollback returns the **code**, not the schema. Migrations are forward-only, so a
change that dropped a column is not coming back — do destructive schema changes
as expand then contract (add the new shape, ship code that uses it, remove the
old shape in a later deploy) rather than as one cutover.

### Querying the database

```bash
cd worker
npx wrangler d1 execute watchtogether --remote --command "SELECT username, discriminator, is_root FROM users"
```

Drop `--remote` for the local development copy. Note the app never deletes a
user row — `is_deleted` is a flag, and soft-deletion also removes their passkey
credentials so the same authenticator can register again.

### Running the cron by hand

```bash
npx wrangler d1 execute watchtogether --remote --command \
  "SELECT COUNT(*) FROM revoked_tokens WHERE expires_at < unixepoch()"
```

There is no way to trigger a scheduled event against production, and
`wrangler dev --test-scheduled` **does not work here** — see the trap below. To
verify the logic, run `npm test` in `worker/`: `src/index.test.ts` calls the
handler directly against real D1.

### Claiming root on a fresh instance

Load `/login` while the users table is empty. The bootstrap panel appears; give
it a username and the `SETUP_SECRET`. It disappears permanently once root
exists, and the endpoint behind it refuses to run a second time.

## The free-tier budget

| Resource | Free daily allowance | What uses it |
|---|---|---|
| Worker requests | 100,000 | `/api/*` only — static assets never invoke the Worker |
| Durable Object requests | 100,000 | Every inbound WebSocket message counts |
| Durable Object duration | 13,000 GB-s (~28 h of active time) | Sockets, while awake |
| D1 reads | 5,000,000 | |
| D1 writes | 100,000 | |
| D1 storage | 5 GB | |
| TURN | 1,000 GB/month | Relayed media, when P2P fails |

Two design choices keep a session inside this:

**High-frequency presence runs peer-to-peer.** Cursors, typing, reactions and
video sync go over the WebRTC DataChannel, not the socket. At 10 Hz, cursor
updates alone would have cost ~36,000 Durable Object requests for one
half-hour two-person session — a third of the daily budget on mouse positions.
They now cost nothing, and a session lands under 100 requests.

**Sockets hibernate.** Accepted with `state.acceptWebSocket()`, so an idle
session holds no memory and burns no GB-s. Keepalives are answered by the
runtime via `setWebSocketAutoResponse` without waking the object.

Watch it on the Cloudflare dashboard under Workers & Pages → `app` → Metrics,
and Durable Objects separately. **Not yet measured against a real session** —
that needs two humans on real devices, and the numbers above are the design
targets, not observations.

## Things that will waste your afternoon

**`wrangler dev --test-scheduled` returns 200 and does nothing.** `/__scheduled`
does not match `run_worker_first = ["/api/*"]`, so the static-asset layer
answers it with `index.html` — a 200 that looks exactly like a successful cron
run, while no cron code executes at all. `src/index.test.ts` covers the handler
instead.

**A missing asset returns 200, not 404.** `not_found_handling =
"single-page-application"` serves `index.html` for anything unmatched, which is
what makes deep links work. Probing `/assets/some-old-hash.js` therefore returns
the SPA shell with the SPA's cache headers, and looks like a broken
`Cache-Control` rule. Check the filename against the live `index.html` first.

**`new_sqlite_classes`, not `new_classes`.** KV-backed Durable Objects are
paid-only. Getting this wrong is the most common silent free-plan deploy
failure.

**Two independent header mechanisms.** `/api/*` headers are set in
`worker/src/middleware/securityHeaders.ts`; everything else is
`frontend/public/_headers`, because static assets never reach the Worker.
Changing one does not change the other. `frontend/tests/csp.test.ts` asserts
the shipped file, since `vite dev` ignores it entirely and production is the
only place it applies.

**Changing `RP_ID` invalidates every passkey.** It is currently the full host
`app.watchtogether.workers.dev`, deliberately, so credentials are not shared
with any other Worker on this account subdomain. Moving to a custom domain means
every user re-registers.

**`request.cf` is undefined under `wrangler dev`.** Rate limiting reads
`CF-Connecting-IP`; the guard for its absence exists, but code added near it
needs the same care.

## Verification after a deploy

```bash
curl -sS https://app.watchtogether.workers.dev/api/health
curl -sSI https://app.watchtogether.workers.dev/login | grep -iE 'content-security-policy|strict-transport'
curl -sSI https://app.watchtogether.workers.dev/api/health | grep -iE 'cache-control|content-security-policy'
```

Expect: health 200; the SPA carrying the full CSP and HSTS; `/api/*` carrying
`no-store` and `default-src 'none'`.

Then, in a browser: sign in with a passkey, create a session, generate an
invite, join it from another profile, and confirm video both ways, chat
(including your own messages appearing), screen share and background blur.

## Getting a quality problem written down

Press **D** in a live session, or the clipboard button beside the quality
control. Both ends can do it — the button sits outside the quality menu on
purpose, because that menu is gated on `isSharer || !isScreenSharing` and the
person watching someone else's share cannot open it at all. That person is the
one who sees the picture freeze.

The report holds the last six minutes at the same three-second cadence
everything else here polls on: the transport path, the operating point asked
for beside what the encoder achieved, bpp, `qualityLimitationReason`, the
encoder implementation, the budget and the encode ceiling — and on the viewer's
side the freeze count, freeze seconds, jitter-buffer delay, dropped frames and
PLI/NACK counts, plus whatever the far end said about itself. The ICE candidate
tables and the last 200 log lines come with it.

Read it top-down. `asked` beside `sending` is the first thing to look at,
because a collapsed frame rate INFLATES bits-per-pixel — `344x182 @ 1 · 0.479
bpp` looks like excellent quality until you see what was requested. Then the
path: `turn/tcp` and a bad picture is a transport problem, not a quality one.

It is assembled in the browser and goes nowhere until somebody pastes it. There
is no sink, and adding one would be a different decision.

## Known gaps

- **No real-session budget numbers.** Needs two people on real devices.
- **Background blur is verified only as far as the CSP.** WebAssembly compiles
  under the live policy and both MediaPipe origins load; that it segments a
  real camera feed correctly in production is untested.
- **The viewer's size has never once reached the sender.** Every debug report
  captured so far ends its `they say` line with `no viewport reported`, through
  three deploys and on both peers, and the cause is not the wire: #25 already
  fixed `validateData` dropping the field, and the worker validator round-trips
  it. It never gets *populated*. `ScreenShareView` measures the viewer's box
  with a `ResizeObserver`, in an effect that reads `videoRef.current` and bails
  when it is null — but the component mounts with the room, long before anyone
  shares, and its empty state returns early with no `<video>` in that branch.
  So the ref is null at mount, and the effect's only dependency is a
  `useCallback(…, [])` that never changes, so it never re-runs when the element
  finally appears. `onViewportChange` was therefore never called once, for the
  whole life of a session.

  The neighbouring `srcObject` effect has the identical guard and works, because
  its dependency list contains `screenStream` — which is what makes this a
  dependency bug rather than a design one.

  What it cost: `viewport` was always null on the sender, so `resolutionBox`
  fell back to `UNKNOWN_VIEWPORT` on `auto` and to no resolution bound at all on
  a fixed preset. The whole viewport feature has been inert since it shipped —
  one layer above the wire bug that #25 fixed, which is why fixing that layer
  did not change the symptom.

  What guards it now: the element is routed through a callback ref into state,
  and both effects depend on it, so they run on the edge where it appears.
  Verified by typecheck and build only — this repo has no component-test
  harness — so the proof is a debug report whose `they say` line names a size.

- **A still screen was read as a failing link, and that is what the reported
  freeze-then-jump actually was.** The first two-machine capture through the
  new debug report (`D` in session) settled it, and it ruled out both standing
  suspects: `p2p/udp · 32 ms rtt · 4.7 Mbps`, and not one `cpu` in sixty
  samples of `qualityLimitationReason`. The tell was elsewhere — long runs of
  `asked 640x360@30 / sending 1280x678@1 / limit none`. `getDisplayMedia` is
  change-driven, so a paused video produces about one frame a second; a picture
  at full size and a thirtieth of the frames is not something bandwidth
  pressure can cause under `maintain-framerate`, which spends resolution first.

  From there both shortage inputs lied at once. The viewer scored the arriving
  1 fps against the sender's ask of 30 — `calculateQualityScore` takes a
  MINIMUM, so 3.9 was the whole verdict — and reported `critical` every 9 s
  forever, since nothing the sender can do makes a paused video move. The
  sender read that as `viewerUnhappy`, and `nextBudget`'s multiplicative branch
  walked 1.9 Mbps to 250 kbps in thirteen polls; the ratio between consecutive
  `updateScreenShareQuality` logs is `BACKOFF_FACTOR` to three decimals. The
  freeze users reported was the *recovery*: the video resumed against a budget
  sized for a still image, with the capturer still at the 1280x678 it had grown
  to, because reconfiguration was grow-only.

  What guards it now: a `'source-idle'` verdict that holds the budget and the
  ladder in BOTH directions and is classified before any reading a link could
  be blamed for (`useSenderHealth.ts`, and it needs the picture to still be at
  full size, so a genuine shortage is untouched); `ShareStatus.sentFps` on the
  wire so the receiver scores what ARRIVED against what was SENT rather than
  against an ask it cannot see; and `CAPTURE_SHRINK_RATIO`, which lets the
  capturer follow the ask down once it is two rungs away. Not yet watched on a
  real link — the same caveat as everything above it.

- **Quality adaptation has now been watched on a real link, and it failed.** A
  session between a 200 Mbps uplink and a 30 Mbps 5G phone, relayed over
  TURN/TCP at 231 ms, sent `344x182 @ 1 fps · 0.03 Mbps`. Three defects
  compounded into a deadlock:

  1. `availableOutgoingBitrate` on a TCP relay is a number about TCP, not about
     the path — it collapsed to within one `BITRATE_STEP` of our own ask.
  2. Nothing floored the budget, so the encoder was asked for 854x480 at
     0.0025 bpp and Chrome improvised a size smaller than any rung we offer.
  3. `classifySenderHealth` returned `'unknown'` for the collapsed state
     (ratio 1.2, reason `'bandwidth'`), which means "hold" to both the budget
     and the ladder. Nothing could move, in either direction.

  What guards it now: a floor of 640x360 at `TARGET_BPP`
  (`operatingPoint.ts`), `capacityKnown` on the estimate so a TCP-relay reading
  can say a preset fits but never that one does not
  (`useUplinkEstimate.ts`), a `'self-limited'` verdict for "our own ceiling is
  the constraint" (`useSenderHealth.ts`), and a `nextBudget` reducer that
  probes upward at 1.5x and reverts exactly on failure. Firefox still publishes
  neither statistic, and there the hooks deliberately have no opinion.

- **The receiver's leg of that loop was a ratchet of its own.** Found while
  checking whether the pipeline is symmetric. Quality feedback was sent only on
  level *change*, and the sender stored it as a bare level that was never
  cleared — not on peer change, not between shares. One `'poor'` therefore made
  `shortage` permanently true in `nextBudget`, which walks the budget to its
  floor and then short-circuits the probe branch that is the only way back up:
  the same deadlock as above, arriving through the other door. The viewer's
  complaint was also inert whenever a trusted estimate sat above what we spend,
  since `min(bps, target)` is a no-op there — so the one shortage GCC cannot see
  (a receiver freezing on a decoder it cannot feed, nothing lost in flight)
  could be reported forever with nothing moving.

  What guards it now: the receiver re-sends its verdict every 9 s
  (`FEEDBACK_HEARTBEAT_MS`) so silence is distinguishable from steady state, the
  sender expires a report after 30 s (`VIEWER_REPORT_TTL_MS`) and clears it on
  peer change and share stop, and a viewer complaint takes the multiplicative
  path when the estimate is not the binding constraint.

- **`auto` could not reach a fast link, and the escape hatch was locked.** The
  mirror image of the collapse, at the top end. `auto` was boxed at 1080p on a
  6 Mbps cap — which could not have funded 4K anyway, since 4K24 needs 6.97 Mbps
  just to reach `TARGET_BPP`. Worse, the preset menu set `disabled` from
  `presetBitrate(key) <= estimate * 0.85`, and `availableOutgoingBitrate` cannot
  exceed what we send: on `auto` the estimate topped out at `auto`'s own cap, so
  `high` (needing 9.6 Mbps of estimate), `ultra` and `extreme` could never
  unlock however fast the link was. The ceiling bounded the measurement that
  would have raised the ceiling, and the only selectable presets were *worse*
  than the one already applied.

  What guards it now: presets are never disabled — a preset is only an upper
  bound and `chooseOperatingPoint` never raises the encoder to one, so an
  unreachable cap is a label (`withinEstimate`), not a lock. `auto` reaches 4K,
  bounded by three things at once: the budget, the preset, and the receiver's
  own viewport, which now rides on the quality heartbeat. `AUTO_MAX_BITRATE` is
  10 Mbps and `MAX_USEFUL_BPP` (0.1) stops a small window absorbing a large
  budget. Measured against the shipped modules: 1080p/4.98 Mbps with no viewport
  report, 4K/9.9 Mbps at 0.050 bpp with a 4K one, 720p/2.2 Mbps into a 1280x720
  window, and floor-to-cap in 108 s on probes alone.

- **`cpu-bound` was a state the whole control loop answered by holding.** A real
  session between two desktop Chromes froze and jumped on the RECEIVER from the
  first second of every share and never recovered, while the sharer's own
  preview stayed smooth — that preview is the raw capture, not the encode, so it
  hides exactly this. Three things compounded:

  1. `nextBudget`'s `cpu-bound` branch is FIRST and returned unchanged, which
     pre-empts every downward path below it including `shortage`. The viewer was
     sending `poor` every nine seconds and the sender could not hear it.
     `nextLadderState` holds on the same verdict, and the only other reaction
     was a toast. Both files' comments named the remedy — "a smaller resolution
     or a cheaper codec" — and neither existed.
  2. `preferVp9` promoted VP9 unconditionally. Apple Silicon has no hardware VP9
     encoder, so that is realtime libvpx. Its own comment had already nominated
     the revert condition: "if this flips the limitation from 'bandwidth' to
     'cpu', this is the change to revert."
  3. `budgetCeilingBps` was built from `MAX_USEFUL_BPP` and both upward branches
     clamped to it, so every share on a link with headroom climbed to **1080p24
     at 4.98 Mbps — 0.100 bpp, three times `TARGET_BPP`** — within about thirty
     seconds. `MAX_USEFUL_BPP`'s own doc says "It is a ceiling on waste, not a
     target. Nothing is ever raised TO it"; the reducer two hundred lines below
     contradicted it.

  What guards it now: `encodeCapacity.ts` — a measured pixels-per-second ceiling
  that is the fourth bound on the picture beside budget, preset and viewport, cut
  by `CAPACITY_BACKOFF` when the encoder is over its cliff and relaxed after
  `CAPACITY_RETRY_MS` so a transient spike cannot pin a session. It bounds
  PIXELS, never bitrate, so `SenderHealth`'s contract holds and bpp rises as the
  picture shrinks. `shouldDowngradeCodec` + `webrtcService.downgradeScreenCodec()`
  move a software VP9 encode to H.264 once, mid-session, over the existing
  renegotiation path (no screen-permission re-prompt — only a fresh
  `getDisplayMedia` does that). `PROBE_CEILING_BPP` (0.05) bounds the climb, so
  1080p24 settles at 2.49 Mbps instead of 4.98. And `updateScreenShareQuality`
  now reconfigures the capturer only when it must GROW past what is actually
  being captured, with 30 s of hysteresis, so a probe/revert cycle cannot restart
  Chrome's capture pipeline every nine seconds.

- **The receiver's viewport had never once crossed the wire.** Found while
  fixing the above. `frontend/src/types/index.ts` declared its own
  `QualityFeedback` with a `viewport` field; the shared contract in
  `worker/src/lib/dataChannelProtocol.ts` had no such field, and `validateData`
  rebuilds the frame field by field — so it was stripped on arrival.
  `grep -rn viewport worker/src` returned nothing. Every `auto` share was
  therefore capped at `UNKNOWN_VIEWPORT` (1080p) for its whole life, and the
  viewport-aware resolution work shipped inert with nothing failing loudly
  enough to say so. The `@shared` alias exists to make exactly this a compile
  error, and it was defeated by a parallel type declaration. `viewport` is now
  in the shared contract with bounds, and `types/index.ts` **re-exports** the
  shared types rather than redeclaring them.

- **The viewer can now see why.** A `share` frame (sharer → viewer, over the
  DataChannel) carries the sender's target fps, geometry, bitrate,
  `qualityLimitationReason` and `encoderImplementation`; the diagnostics panel
  shows the receiver's own `freezeCount`, freeze seconds, jitter-buffer delay,
  dropped frames and PLI/NACK counts beside them. The person who sees a screen
  share fail is not the person whose statistics explain it, which is how far the
  last report got: "it looks choppy". The same frame fixes the fps yardstick —
  `calculateQualityScore` was judging a 24 fps film share against 30.

- **None of the top-end work has been watched on a real link.** It is verified
  by unit tests and by evaluating the real modules in a browser, not by two
  people on 4K screens. The viewport measurement in particular — element box
  times `devicePixelRatio`, via `ResizeObserver` — has never been read off a
  real receiver.

- **Why UDP relay lost is still unanswered.** `getIceDiagnostics()` /
  `formatIceDiagnostics()` in `frontend/src/services/webrtcService.ts` dump the
  candidate and pair tables via `logger.warn` whenever a session ends up
  relayed over TCP. Whether the fix is client-side, a Cloudflare TURN config
  change, or nothing we control depends on what that dump shows.
