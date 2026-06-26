# WatchTogether Deployment Notes

Production runbook + post-deploy state. Last updated 2026-04-26.

## Live URLs

| What | URL |
|------|-----|
| Frontend | https://watchtogether.lol |
| Backend API | https://api.watchtogether.lol |
| Health check | https://api.watchtogether.lol/api/health |
| Fly default (frontend) | https://watchtogether-web.fly.dev |
| Fly default (backend) | https://watchtogether-api.fly.dev |

## Hosting

- **Provider:** Fly.io, region `ams` (Amsterdam)
- **Backend app:** `watchtogether-api` — always-on (`auto_stop_machines = "off"`) so SignalR sessions don't drop
- **Frontend app:** `watchtogether-web` — auto-stops when idle (cold start ~1s)
- **Database:** MongoDB Atlas free tier (`<your-cluster>.mongodb.net`), user `<your-db-user>`
- **Email:** Resend with `noreply@watchtogether.lol` (domain verified, SPF + DKIM + MX in DNS)
- **TURN/STUN:** Cloudflare Realtime TURN — short-lived ICE credentials minted per request via the Cloudflare API (`WebRTC__CloudflareTurnKeyId` + `WebRTC__CloudflareTurnApiToken`); falls back to static coturn creds if those are unset
- **Domain registrar:** Spaceship (`watchtogether.lol`)
- **TLS:** Let's Encrypt via Fly, auto-renewed by Fly

## Fly secrets (backend)

| Name | Purpose |
|------|---------|
| `Jwt__Secret` | JWT signing key (≥32 bytes, openssl rand -base64 48) |
| `MongoDB__ConnectionString` | Atlas SRV URI with rotated password |
| `Email__ResendApiKey` | Resend API key (named `fly-watchtogether-api`) |
| `Email__FromEmail` | `noreply@watchtogether.lol` |
| `WebRTC__CloudflareTurnKeyId` | Cloudflare Realtime TURN key id |
| `WebRTC__CloudflareTurnApiToken` | Cloudflare Realtime TURN API token — mints short-lived ICE creds |

Non-secret config lives in `backend/fly.toml` `[env]` block (Issuer, Audience, AllowedHosts, CORS origins, etc.).

## Common operations

### Deploy after code change
```bash
cd backend && fly deploy --app watchtogether-api
cd ../frontend && fly deploy --app watchtogether-web
```
Frontend `VITE_*` env vars are baked at build time — change requires redeploy.

### Logs
```bash
fly logs --app watchtogether-api
fly logs --app watchtogether-api --no-tail | tail -50   # historical, one-shot
```

### Rotate a secret
```bash
fly secrets set --app watchtogether-api Jwt__Secret='<new value>'
```
Triggers rolling restart automatically. Set multiple secrets in one command to restart only once.

### Connect to Atlas
```bash
mongosh "mongodb+srv://<your-db-user>:<password>@<your-cluster>.mongodb.net/watchtogether"
```

### Promote a user to root
```bash
mongosh "<atlas uri>" --quiet --eval 'db.users.updateOne({email: "user@example.com"}, {$set: {isRootUser: true}})'
```

### Generate an invitation link via API
```bash
TOKEN=$(curl -sS -X POST https://api.watchtogether.lol/api/auth/login \
  -H 'Content-Type: application/json' \
  -d '{"email":"oahmetkutay@gmail.com","password":"<pw>"}' \
  | sed -E 's/.*"token":"([^"]+)".*/\1/')
curl -sS -X POST https://api.watchtogether.lol/api/invitation/generate-link \
  -H "Authorization: Bearer $TOKEN"
```

## Local development

`docker-compose up` is the canonical dev path (uses local MongoDB container, picks up `.env` for secrets).

For raw `dotnet run`: `appsettings.Development.json` carries a clearly-marked `DEV_ONLY_NOT_FOR_PROD_*` JWT secret so local boot works without env-var setup. Production overrides are enforced by `appsettings.Production.json` having empty values + Program.cs strict validation.

## Outstanding follow-ups

These didn't block deploy but should be addressed:

| Priority | Item | Where |
|----------|------|-------|
| P2 | Bump shareable invite link expiry from 15 min to 7 days | `backend/Business/Services/InvitationLinkService.cs:14` `LINK_EXPIRY_MINUTES` |
| P2 | Add "Revoke active invite link" UI in the Lobby | `frontend/src/components/Lobby/Lobby.tsx` — without it users get stuck once `isInvitationTicketUsed = true`. `revoke-link` API endpoint already exists. |
| P2 | Replace `Console.WriteLine` in EmailService with `ILogger.LogInformation` | `backend/Business/Services/EmailService.cs` (T2.4 missed this file) |
| P3 | Implement password reset flow (`/api/auth/password-reset/{request,confirm}`) | New endpoints; mirror email-verification flow |
| P3 | Replace JWT-in-storage with HttpOnly cookie + CSRF token | Real fix for XSS-readable JWT (T2.3 only changed the default) |
| P3 | Per-email rate-limit partition for login | `backend/API/Program.cs` rate limiter — defends credential stuffing across rotated IPs |
| P3 | Structured logging + log shipping (Serilog → Better Stack / Axiom) | Replace stdout logging |
| P4 | npm audit fix (8 build-tool advisories) | `frontend/` |

## Things to remember when something goes wrong

- **Health check shows critical but app responds 200?** Fly's check-status display gets stuck after failed deploys; the actual machine is fine. Trust `curl` over `fly checks list`.
- **Deploy times out at "waiting for health checks"?** The CLI is timing out on its own API call, not the actual check. Verify with `fly machine status` and `curl /api/health`.
- **`Email__ResendApiKey` missing → emails silently no-op.** EmailService returns `true` even when key is empty (see line 36 of EmailService.cs). Symptoms: registration "succeeds" but no email arrives. Always confirm secret is set after deploy.
- **`AllowedHosts` too tight → "400 Invalid Hostname".** Any new subdomain or platform hostname must be added to the semicolon-separated `AllowedHosts` env var in `backend/fly.toml`.

## Verification (run after major changes)

1. `curl https://api.watchtogether.lol/api/health` → 200 with status:healthy
2. `curl -I https://watchtogether.lol/` → headers include CSP, HSTS, X-Frame-Options:DENY
3. Login with the root account, create a session, generate an invite, join from incognito
4. Two-peer WebRTC: cameras visible both ways, screen share works
5. SignalR negotiate request has `Authorization: Bearer ...` header — NO `?access_token=` in URL (T2.1)
6. Hammer 6 wrong logins in 1 minute → 6th returns 429 (T1.5)
7. From User B's devtools: `fetch('/api/session/<A-session-id>/invite', {method:'POST', headers:{Authorization:'Bearer '+sessionStorage.getItem('token')}})` → 403 (T1.4)

## Related artifacts

- Hardening commit: `90d986a Harden security and migrate deployment from Railway to Fly.io`
