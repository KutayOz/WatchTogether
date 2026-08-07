# WatchTogether

**Two people, one screen. Video call, screen share and synced YouTube, on infrastructure that costs nothing.**

![React](https://img.shields.io/badge/React-19-blue?style=flat-square&logo=react)
![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers%20%2B%20DO%20%2B%20D1-orange?style=flat-square&logo=cloudflare)
![WebRTC](https://img.shields.io/badge/WebRTC-P2P-green?style=flat-square)
![License](https://img.shields.io/badge/License-MIT-blue?style=flat-square)

**Live:** https://app.watchtogether.workers.dev

## About

WatchTogether is a two-person video calling app with screen sharing, synchronized
YouTube playback and ML background blur. Media never touches a server — WebRTC
connects the peers directly, and the backend exists only to introduce them.

Sign-in is a passkey or a password — passkeys are the recommendation, not a
requirement. There is no email address and no sign-up form: accounts exist by
invitation, and you are identified by a tag like `alice#0042`.

It runs entirely on Cloudflare's free tier. That is a design constraint rather
than a happy accident, and it shows up throughout — see [Why it is shaped like
this](#why-it-is-shaped-like-this).

## Features

- **P2P video calling** — WebRTC direct peer connections, no media servers
- **Screen sharing** — full-resolution, clamped to what the connection's own
  bandwidth estimate says it can carry
- **Synced YouTube co-watching** — paste a link, both sides stay in step
- **Background blur** — MediaPipe segmentation, lazy-loaded (~2 MB, only when switched on)
- **Passkey sign-in** — usernameless and discoverable; nothing to type, nothing to leak
- **Password sign-in** — for anyone who cannot or would rather not use a passkey,
  stretched in the browser so the Worker never sees it
- **Invite-only accounts** — single-use links, quota-limited per user
- **Reconnect that actually rejoins** — refresh mid-call and the session recovers
- **Admin panel** — user tree, invite slots, audit log
- **Perfect negotiation** — renegotiation with glare handling

## Tech stack

**Frontend** — React 19, TypeScript 5.9, Vite 7, Tailwind 4, `webrtc-adapter`,
`@mediapipe/tasks-vision`, `@simplewebauthn/browser`. Vitest for units,
Playwright for the screens.

**Backend** — a single Cloudflare Worker: Hono for routing, `jose` for JWTs,
`@simplewebauthn/server` for WebAuthn. Two Durable Object classes hold live
state; D1 (SQLite) holds everything durable. Tests run in `workerd` itself via
`@cloudflare/vitest-pool-workers` — real Durable Objects, real D1, real WebAuthn
ceremonies, not mocks.

**Infrastructure** — Cloudflare Workers, Durable Objects, D1, Realtime TURN,
Cron Triggers. GitHub Actions for CI and deploys. Two accounts, both free.

## Getting started

### Prerequisites

Node 22+, and a Cloudflare account if you intend to deploy. Nothing else — no
database to install, no containers.

```bash
git clone https://github.com/KutayOz/WatchTogether.git
cd WatchTogether
```

### Run it locally

Two terminals. The Worker first:

```bash
cd worker
npm ci
cp .dev.vars.example .dev.vars
npm run db:migrate:local
npm run dev
```

Then the frontend:

```bash
cd frontend
npm ci
npm run dev
```

Open http://localhost:5173. Vite proxies `/api/*` — WebSocket upgrade included —
to `wrangler dev` on :8787, so the app runs single-origin exactly as it does in
production.

`.dev.vars.example` holds clearly-labelled development placeholders and no real
credentials. It sets the WebAuthn relying party to `localhost`, which is the one
non-HTTPS origin browsers will run a passkey ceremony against.

### Claim the first account

The first account cannot be invited by anybody, so an empty database plus a
deployment secret is the only way in. Load `/login` with no users in the
database and a bootstrap panel appears; the secret is the `SETUP_SECRET` from
`.dev.vars`. The panel disappears permanently the moment root exists. Claiming
root is passkey-only — it happens once, at a keyboard.

From there: lobby → generate an invite link → open it in another profile → that
person picks a passkey or a password and lands signed in.

### Verify

```bash
curl http://localhost:8787/api/health
```

## Architecture

```
frontend/                     React SPA; dist/ is served by the Worker
└─ src/
   ├─ components/             Auth, Lobby, Session, Chat, Admin, Settings, manga/ (the design system)
   ├─ services/
   │  ├─ api.ts               REST client, cookie auth
   │  ├─ transportService.ts  Facade: routes each message to WS or DataChannel
   │  ├─ wsService.ts         Signalling socket
   │  ├─ dataChannelService.ts  Peer-to-peer presence
   │  └─ webrtcService.ts     RTCPeerConnection, tracks, renegotiation
   ├─ hooks/                  useWebRTC, useTransport, useBackgroundBlur, useMediaDevices …
   └─ context/                AuthContext, SessionContext

worker/
├─ wrangler.toml              Bindings, cron, assets, RP config
├─ migrations/0001_init.sql   The whole schema
└─ src/
   ├─ index.ts                Hono app, WS route, cron handler, DO exports
   ├─ do/
   │  ├─ SessionRoom.ts       One instance per session: participants, sockets, grace, invite
   │  └─ AuthChallenge.ts     One instance per in-flight WebAuthn ceremony
   ├─ routes/                 auth, passkey, session, invitation, terms, admin
   ├─ middleware/             auth, rateLimit, securityHeaders
   ├─ db/                     users, credentials, invitationLinks, revokedTokens, audit
   └─ lib/                    jwt, cookies, crypto, identity, ice, protocol, dataChannelProtocol
```

### How a call happens

1. **Sign in** — passkey ceremony against `AuthChallenge`, then a JWT in a
   `__Host-` cookie.
2. **Create a session** — `POST /api/session/create` names a `SessionRoom`.
3. **Connect** — `wss://…/api/session/ws/:sessionId`. The socket *is* the join:
   the Worker checks the cookie and forwards the upgrade, so reconnecting is
   rejoining, with no separate join message to forget to re-send.
4. **Signal** — offer / answer / ICE relayed by the Durable Object.
5. **Stream** — video, audio and screen share flow peer-to-peer.
6. **Presence** — cursors, typing, reactions and video sync go over the WebRTC
   DataChannel, never the server.

### Two transports, on purpose

Every inbound WebSocket message is a billable Durable Object request, and the
free tier allows 100,000 a day. Cursor updates alone fire at 10 Hz — a
half-hour screen share would spend roughly a third of the daily budget on mouse
positions.

So the protocol is split. Anything that must survive a broken peer connection
stays on the WebSocket: offer, answer, ICE, chat, media state, screen-share
negotiation, join and leave. Chat stays specifically so that someone can type
"I can't see you" when the video has failed.

Everything high-frequency that is only meaningful once the peers are connected
moves to the DataChannel, where it costs nothing: cursors, typing, reactions,
video sync, quality feedback. A thirty-minute session goes from ~36,000 Durable
Object requests to under 100.

`transportService.ts` is the seam. Callers name a message; it decides the wire.

## Why it is shaped like this

Four platform limits explain most of the unusual decisions.

**10 ms of CPU per invocation.** This is the limit that shaped the auth design,
and for a while it shaped it wrongly, so it is worth setting out properly.

The limit is CPU time, not wall clock: awaiting D1 costs nothing against it,
which is why a chain of queries is fine. What it does rule out is deliberately
expensive work — and password hashing is nothing but deliberately expensive
work. BCrypt at work factor 12 costs ~400 ms, forty times the entire budget, and
bcrypt, scrypt and argon2 do not exist on Workers regardless. PBKDF2 via
`crypto.subtle` is the only primitive available, and OWASP asks for 600,000
iterations of it, which measures at ~37 ms in workerd. Also over budget.

The original port drew the obvious conclusion from that — passwords are
impossible here — and removed them. The measurement was right and the conclusion
was one step too far, because it assumed the stretching had to happen on the
server. It does not. The browser has no 10 ms budget:

- the browser runs PBKDF2-SHA256 at 600,000 iterations over a salt derived from
  the username, and sends the derived key instead of the password
- the Worker runs 20,000 more over a random per-row salt, and stores that

An attacker holding the table pays both halves, ~620,000 iterations per guess.
The Worker pays ~1.2 ms. The Worker never sees a plaintext password at all.

Two things follow, and both are real costs rather than free wins. Password
policy — length, blocklist — can only be enforced in the browser, because the
server has nothing to inspect; that is tolerable because a bypassed rule weakens
only the bypasser's own account. And the client's recipe is effectively frozen:
at sign-in the browser must derive before the server has said anything, so it
cannot know which recipe a stored row used. The server's iteration count is
upgradable in place and rehashes on login; the client's is not.

`worker/src/lib/password.ts` and `lib/passwordHash.ts` carry the details. Invite
tokens, separately, are hashed with SHA-256 rather than anything slow because
they already carry 256 bits of entropy — there is no guessing attack for a cost
factor to slow down.

**100,000 Durable Object requests a day.** The transport split above. Also why
`run_worker_first = ["/api/*"]` — static assets never invoke the Worker at all,
so the SPA is free and unmetered, and why the WebSocket lives at
`/api/session/ws/:id` rather than somewhere prettier.

**13,000 GB-s a day — about 28 hours of *active* Durable Object time.** A design
that held idle sockets awake would burn that in an afternoon, so hibernation is
load-bearing: sockets are accepted with `state.acceptWebSocket()` and
participants are derived from socket tags and attachments rather than stored.
"Who is in the room" and "who has a socket" cannot drift apart, because they are
the same question.

**SQLite-backed Durable Objects only.** KV-backed classes are a paid feature.
`new_sqlite_classes` in `wrangler.toml` is the difference between a deploy and a
silent rejection.

One consequence worth naming: passkeys are bound to
`app.watchtogether.workers.dev`. Moving to a custom domain later means everyone
re-registers.

## Tests

```bash
cd worker    && npm test    # 281 — Durable Objects, D1, WebAuthn, PBKDF2, in workerd
cd frontend  && npm test    # 202 — services, hooks, storage, the shipped CSP
cd frontend  && npm run e2e # 34  — Playwright, /api/* stubbed at the boundary
```

All three run on every pull request and again before every deploy
(`.github/workflows/`). `npm run e2e:ui` opens Playwright's interactive runner.

The worker suite runs against the real runtime rather than doubles, which is
what makes it worth trusting: a Durable Object alarm really fires, D1 really
enforces its constraints, and a WebAuthn assertion is really verified.

## Deployment

Push to `main`. GitHub Actions builds the SPA, applies D1 migrations and deploys
the Worker, having run every check first.

Manually, if you must:

```bash
cd frontend && npm run build
cd ../worker && npm run db:migrate:remote && npm run deploy
```

Build order matters — `wrangler.toml` points `[assets]` at `../frontend/dist`,
so a Worker deployed before the SPA is built ships yesterday's frontend.

See [DEPLOYMENT.md](DEPLOYMENT.md) for secrets, runbook and the free-tier budget.

## Security

- **Passkeys** — discoverable credentials, `residentKey: "required"`; usernameless,
  so nothing is submitted to be looked up and there is nothing to phish
- **Passwords** — stretched in the browser at 600,000 PBKDF2 iterations before
  they are sent, then hashed again server-side with a random per-row salt. This
  is the one part of the app with an account-enumeration surface, so it is
  closed by hand: unknown handle, handle with no password, and wrong password
  all return one byte-identical 401, and the miss path burns an equivalent
  verification against a dummy hash so it costs the same as a hit. Eight
  consecutive failures lock the account for fifteen minutes — short on purpose,
  since anyone who knows a handle could otherwise hold it locked
- **No password recovery by email** — because there is no email. Root issues a
  single-use 48-hour reset link by hand, and every issue and redemption is
  audited
- **JWT in a `__Host-` cookie** — HttpOnly, `Secure`, `Path=/`, no `Domain`;
  JavaScript cannot read it, and cookie lifetime is derived from the same `exp`
  it was signed with
- **Single-use challenges** — read and deleted in one Durable Object
  invocation, so an assertion cannot be replayed
- **Rate limiting** — Workers rate-limiting bindings on HTTP, plus a per-socket
  token bucket inside the Durable Object, because WebSocket messages bypass HTTP
  limits entirely
- **Session isolation** — a socket is bound to its session by the object that
  owns it, so no message can name someone else's session
- **Headers** — CSP, HSTS, `X-Frame-Options`, `Referrer-Policy`,
  `Permissions-Policy`, COOP; strict `default-src 'none'` on `/api/*`
- **Audit log** — every administrative action, with actor and target

## History

The first version of this app was .NET 8 + SignalR + MongoDB Atlas on Fly.io.
It was rewritten for Cloudflare in 2026, keeping the frontend and replacing the
backend outright — passwords, email verification and Google sign-in went with
it. Email verification and Google sign-in are still gone. Passwords came back,
in a shape the platform can actually run; see [Why it is shaped like
this](#why-it-is-shaped-like-this).

That tree is preserved at the `archive/dotnet` tag, because comments across
`worker/` and `frontend/` still cite the C# they were ported from:

```bash
git show archive/dotnet:backend/API/Hubs/WatchTogetherHub.cs
```

## Roadmap

Not planned, deliberately: 3+ party calling (the whole design assumes two
people), recording, chat history.

Possible: custom background images, vanity session URLs.

## License

MIT — see [LICENSE](LICENSE).
