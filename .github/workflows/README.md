# CI/CD

Three files, two of which are entry points:

| | Trigger | Does |
|---|---|---|
| `checks.yml` | called by the other two | typecheck + tests + build, worker and frontend in parallel |
| `ci.yml` | every pull request | runs `checks.yml` |
| `deploy.yml` | push to `main`, or manual | runs `checks.yml`, then migrates D1 and deploys |

The checks live in one file so "CI is green" and "what we deployed was tested" cannot drift apart.

## One-time setup

Nothing deploys until two repository secrets exist. Add them under
**Settings → Secrets and variables → Actions → New repository secret**.

### `CLOUDFLARE_API_TOKEN`

In the Cloudflare dashboard: **My Profile → API Tokens → Create Token**, start
from the **Edit Cloudflare Workers** template, and add **D1 → Edit** so the
migration step can run. Scope it to this account only.

This is a scoped token, not your account password and not an OAuth session. If
it leaks you revoke that one token; nothing else is exposed.

Cloudflare shows the value exactly once. Paste it straight into GitHub.

### `CLOUDFLARE_ACCOUNT_ID`

On the Workers & Pages overview page in the dashboard. Not a secret in the
strict sense — it is an identifier, useless without the token — but it lives
alongside it for convenience.

## Turning CI into an actual gate

A green tick nobody is required to look at protects nothing. Under
**Settings → Rules → Rulesets**, add a ruleset targeting `main` that requires:

- a pull request before merging
- the `worker` and `frontend` status checks to pass
- branches to be up to date before merging — this is the one that would have
  caught the first two pull requests on this repo, which were branched off a
  `main` that predated the Cloudflare rewrite

## Cost

£0/$0. GitHub Actions is unlimited for public repositories; private ones get
2,000 minutes a month on the free plan. A full run here is about a minute.

## Things worth knowing

**Secrets and forked pull requests.** This repository is public. GitHub does not
pass secrets to workflows triggered by pull requests from forks, so a stranger
cannot open a pull request that prints the Cloudflare token. The footgun is
`pull_request_target`, which *does* get secrets — do not add it without a
specific reason.

**Build order is load-bearing.** `wrangler.toml` points `[assets]` at
`../frontend/dist`, so `deploy.yml` builds the SPA before uploading the Worker.
Reverse those two steps and you ship yesterday's frontend with today's backend.

**Migrations are forward-only.** `wrangler rollback <version-id>` returns the
*code* to a previous version — every deploy is retained, and the id is printed
in the run summary. A migration that dropped a column is not coming back, so
destructive schema changes need expand/contract (add the new shape, ship code
using it, remove the old shape in a later deploy) rather than a single cutover.

**Lint is not a gate yet.** `npm run lint` reports 12 pre-existing errors in
`ScreenShareView.tsx`, the Playwright specs and `webrtcService.ts`. A gate that
is red the day you add it is a gate people learn to skip. Fix those first;
`checks.yml` has the job commented out and ready.

**The worker suite needs `.dev.vars`.** It is gitignored, because that is where
real secrets land during local debugging, so `checks.yml` copies
`.dev.vars.example` over it. Without that step the suite fails on
`Imported HMAC key length (0)`, which points nowhere near the actual cause.
This was found by running the suite in a clean checkout — exactly the class of
problem CI exists to surface.
