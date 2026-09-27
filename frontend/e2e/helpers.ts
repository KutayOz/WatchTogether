import { Page, expect } from '@playwright/test';

/**
 * Test-side helpers for stubbing the API boundary.
 *
 * The frontend talks to the Worker through fetch() against the same origin
 * (`vite dev` proxies /api → `wrangler dev` in real life, but in E2E we
 * intercept the request before it even leaves the page). All routes here are
 * relative to baseURL.
 *
 * Convention: each mock function returns the Promise<void> from page.route()
 * so callers can `await` them in a `beforeEach`.
 */

/** Body shape returned by the real /api/auth/me endpoint. Kept here as a
 *  loose-typed copy so we don't pull frontend type imports into the test
 *  config (Vite + Playwright TS roots are separate). */
interface MeShape {
  username: string;
  discriminator: string;
  /** `username#1234` — the server precomputes it so the two cannot drift. */
  tag: string;
  isRootUser?: boolean;
  hasAcceptedTerms?: boolean;
}

/**
 * Stand the user up as authenticated for the lifetime of the test.
 *
 * useAuth() does NOT call /me unless there's a cached user in storage
 * (optimistic-render pattern — see useAuth.ts line ~47). So an /api/auth/me
 * mock by itself isn't enough: we also have to pre-seed localStorage with
 * the same keys getCachedUser() looks for. addInitScript runs in the page
 * context *before* any application script, so the React init() sees the
 * cache as if the user had already signed in on a prior visit.
 *
 * The /me mock is still useful — useAuth's background-verify path fires
 * after the initial render and overwrites state from this response. Without
 * the mock, /me would hit the dev server (or fail), potentially clearing
 * the optimistic state via the 401 redirect path.
 *
 * There is no token to fake. The JWT lives in an HttpOnly cookie that JS
 * cannot write, which is the point — everything seeded here is public UI
 * state that grants nothing on its own.
 */
export async function mockLoggedInUser(page: Page, overrides: Partial<MeShape> = {}) {
  const user: MeShape = {
    username: 'alice',
    discriminator: '0042',
    tag: 'alice#0042',
    isRootUser: false,
    hasAcceptedTerms: true,
    ...overrides,
  };
  // 1) Seed storage so the optimistic-render path turns the user on. These are
  //    exactly the AUTH_KEYS in authStorage.ts; 'username' is the sentinel
  //    getCachedUser() requires before it will return a user at all.
  await page.addInitScript((u) => {
    localStorage.setItem('username', u.username);
    localStorage.setItem('discriminator', u.discriminator);
    localStorage.setItem('tag', u.tag);
    localStorage.setItem('isRootUser', String(u.isRootUser ?? false));
    localStorage.setItem('hasAcceptedTerms', String(u.hasAcceptedTerms ?? true));
  }, user);
  // 2) Mock /me so the background-verify confirms (instead of clearing state).
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(user),
    });
  });
}

/** Logged-out: /me returns 401 → AuthContext stays null → ProtectedRoute
 *  bounces to /login. The default for tests that exercise the auth screens. */
export async function mockLoggedOut(page: Page) {
  await page.route('**/api/auth/me', async (route) => {
    await route.fulfill({ status: 401, contentType: 'application/json', body: '{}' });
  });
}

/**
 * Whether the instance already has a root account.
 *
 * /login calls this on mount and shows the first-run bootstrap form only when
 * it answers false, so every test touching that screen has to pin it — an
 * unmocked call reaches the dev server and the panel's visibility becomes a
 * property of whatever is in the local database.
 */
export async function mockSetupStatus(page: Page, isSetupComplete: boolean) {
  await page.route('**/api/auth/setup/status', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ isSetupComplete }),
    });
  });
}

/**
 * Drive a passkey sign-in to a chosen outcome.
 *
 * Two halves, because a passkey ceremony has two:
 *
 *   - The *authenticator* half is stubbed by replacing navigator.credentials.
 *     Chromium does expose a virtual authenticator over CDP, but it only
 *     answers a challenge for a credential it holds, and minting one means
 *     hand-rolling a PKCS#8 key whose signature the mocked server half would
 *     then ignore anyway. The stub is the honest version of the same fiction.
 *   - The *server* half is stubbed with page.route().
 *
 * So this covers the screen's wiring — button → ceremony → state → redirect,
 * and the failure path back to the OOPS burst. It deliberately proves nothing
 * about WebAuthn verification itself; that lives in the Worker's own suite
 * (worker/src/routes/passkey.test.ts), where it runs against real crypto.
 */
export async function mockPasskeySignIn(
  page: Page,
  outcome: 'success' | 'cancelled',
  user: Partial<MeShape> = {},
) {
  await page.addInitScript((shouldSucceed) => {
    Object.defineProperty(navigator, 'credentials', {
      configurable: true,
      value: {
        get: async () => {
          if (!shouldSucceed) {
            // What a real authenticator throws when the user dismisses the
            // system sheet. useAuth maps it to the message the burst shows.
            throw new DOMException('The operation either timed out or was not allowed.', 'NotAllowedError');
          }
          // @simplewebauthn/browser reads these fields off the credential and
          // re-encodes them; the shapes matter, the bytes do not, because the
          // /finish mock below never looks at them.
          const empty = new ArrayBuffer(0);
          return {
            id: 'dGVzdC1jcmVkZW50aWFs',
            rawId: empty,
            type: 'public-key',
            authenticatorAttachment: 'platform',
            response: {
              clientDataJSON: empty,
              authenticatorData: empty,
              signature: empty,
              userHandle: empty,
            },
            getClientExtensionResults: () => ({}),
          };
        },
      },
    });
  }, outcome === 'success');

  await page.route('**/api/auth/passkey/auth/begin', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        challenge: 'Y2hhbGxlbmdl',
        rpId: 'localhost',
        timeout: 60000,
        userVerification: 'preferred',
        // Usernameless: the authenticator picks from its discoverable
        // credentials rather than being handed a list.
        allowCredentials: [],
      }),
    });
  });

  await page.route('**/api/auth/passkey/auth/finish', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        discriminator: '0042',
        tag: 'alice#0042',
        isRootUser: false,
        hasAcceptedTerms: true,
        ...user,
      }),
    });
  });
}

/**
 * Drive a password sign-in to a chosen outcome.
 *
 * Simpler than its passkey counterpart in one way and slower in another. There
 * is no ceremony, so navigator.credentials does not have to be faked — only the
 * server half is stubbed. But the page still runs the real 600,000-iteration
 * PBKDF2 before it calls anything, because that happens in utils/password.ts
 * and is not mocked here. Expect a few hundred milliseconds per sign-in, and
 * more on a shared CI runner.
 *
 * If a spec using this starts flaking on a slow machine, raise its timeout.
 * Lowering the iteration count would be mocking away the thing under test.
 */
export async function mockPasswordSignIn(
  page: Page,
  outcome: 'success' | 'wrong-password' | 'locked',
  user: Partial<MeShape> = {},
) {
  await page.route('**/api/auth/password/login', async (route) => {
    if (outcome === 'wrong-password') {
      // One string for unknown handle, no password set, and wrong password —
      // see routes/password.ts. Anything else is an enumeration oracle.
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({ message: 'That handle and password do not match.' }),
      });
      return;
    }

    if (outcome === 'locked') {
      await route.fulfill({
        status: 429,
        contentType: 'application/json',
        headers: { 'Retry-After': '900' },
        body: JSON.stringify({
          message: 'Too many attempts. Try again in 15 minutes.',
          retryAfterSeconds: 900,
        }),
      });
      return;
    }

    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username: 'alice',
        discriminator: '0042',
        tag: 'alice#0042',
        isRootUser: false,
        hasAcceptedTerms: true,
        ...user,
      }),
    });
  });
}

/** Stub the probe /reset/:token makes on mount, and the redemption after it. */
export async function mockPasswordReset(
  page: Page,
  validity: 'valid' | 'used' | 'expired' | 'not_found',
  username = 'alice',
) {
  await page.route('**/api/auth/password/reset/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        validity === 'valid'
          ? { valid: true, username, tag: `${username}#0042` }
          : { valid: false, reason: validity },
      ),
    });
  });

  // Distinct from the probe above: same prefix, no token segment, POST only.
  await page.route('**/api/auth/password/reset', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username,
        discriminator: '0042',
        tag: `${username}#0042`,
        isRootUser: false,
        hasAcceptedTerms: true,
      }),
    });
  });
}

/** Stub the invite-link check /invite/:token makes on mount. */
export async function mockInviteLink(page: Page, valid = true, inviterTag = 'bob#0007') {
  await page.route('**/api/invitation/validate/*', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify(
        valid ? { valid: true, inviterTag } : { valid: false, message: 'That invite is not valid.' },
      ),
    });
  });
}

/** Stub invite-scoped password signup. */
export async function mockPasswordSignup(page: Page, username = 'ada') {
  await page.route('**/api/auth/password/signup', async (route) => {
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        username,
        discriminator: '0042',
        tag: `${username}#0042`,
        isRootUser: false,
        hasAcceptedTerms: true,
      }),
    });
  });
}

/** Track every JS chunk the page downloads. Useful for the code-split
 *  assertions — "did landing on /login pull in the session chunk?" */
export function trackChunkRequests(page: Page) {
  const downloaded: string[] = [];
  page.on('request', (req) => {
    const url = req.url();
    // We care about /assets/*.js files. Vite emits chunks with hashed
    // names like /assets/auth-NL9fgHYe.js, so we extract the prefix
    // (before the first hyphen) as the chunk name.
    const match = url.match(/\/assets\/([^/]+)\.js(?:\?|$)/);
    if (match) downloaded.push(match[1]);
  });
  return {
    /** Return the set of unique chunk-name prefixes seen so far. */
    chunks: () => new Set(downloaded.map((n) => n.split('-')[0])),
  };
}

/** Quick wait — page is fully idle (no in-flight requests, no transitions).
 *  More reliable than fixed timeouts when working with React Suspense + lazy. */
export async function waitForFullyLoaded(page: Page) {
  await page.waitForLoadState('networkidle');
}

/**
 * Kill all animation for the page lifetime.
 *
 * Two halves, because the app animates two ways:
 *
 *   - CSS keyframes and transitions (grain, spinners, hover springs) are
 *     zeroed by a stylesheet injected at init time.
 *   - JavaScript motion (motion's springs, the WAAPI shakes and ripples, the
 *     canvas projector and dust) all read prefers-reduced-motion, so emulating
 *     it switches them to instant changes and single static frames.
 *
 * Playwright refuses to click an element whose box is still moving, so an
 * entrance spring or a magnetic button would otherwise make clicks wait.
 *
 * Tradeoff: we lose the ability to assert that animations are playing. The
 * specs in motion.spec.ts do that on purpose, without this helper.
 */
export async function disableAnimations(page: Page) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(() => {
    const style = document.createElement('style');
    style.textContent = `
      *, *::before, *::after {
        animation-duration: 0s !important;
        animation-delay: 0s !important;
        transition-duration: 0s !important;
        transition-delay: 0s !important;
      }
    `;
    // Defer to DOMContentLoaded so <head> exists. Init scripts run before
    // any document — appending now to documentElement is the safe bet.
    if (document.head) {
      document.head.appendChild(style);
    } else {
      document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style), { once: true });
    }
  });
}

/** Assert the page is on the expected pathname (ignoring querystring). */
export async function expectPathname(page: Page, expected: string) {
  await expect.poll(() => new URL(page.url()).pathname).toBe(expected);
}

/** JSON reply, the one shape every stub below sends. */
function json(body: unknown, status = 200) {
  return { status, contentType: 'application/json', body: JSON.stringify(body) };
}

/**
 * The lobby's API: the invite book and the one self-serve invite link.
 *
 * Stateful on purpose — generating a link spends a ticket and makes it the
 * active link, revoking clears it — so a spec can walk the whole modal and
 * see the ticket book change underneath it.
 */
export async function mockLobby(
  page: Page,
  opts: { maxSlots?: number | null; usedSlots?: number; activeLinkExpiresAt?: number | null } = {},
) {
  const state = {
    maxSlots: opts.maxSlots === undefined ? 3 : opts.maxSlots,
    usedSlots: opts.usedSlots ?? 1,
    activeLinkExpiresAt: opts.activeLinkExpiresAt ?? null,
    generated: 0,
  };
  const slots = () => ({
    maxSlots: state.maxSlots,
    usedSlots: state.usedSlots,
    remainingSlots: state.maxSlots === null ? null : state.maxSlots - state.usedSlots,
    isUnlimited: state.maxSlots === null,
  });

  await page.route('**/api/invitation/available-slots', (route) => route.fulfill(json(slots())));
  await page.route('**/api/invitation/active-link', (route) =>
    route.fulfill(json({ hasActiveLink: state.activeLinkExpiresAt !== null, expiresAt: state.activeLinkExpiresAt })),
  );
  await page.route('**/api/invitation/generate-link', (route) => {
    state.generated += 1;
    state.usedSlots += 1;
    state.activeLinkExpiresAt = Date.now() + 48 * 3600 * 1000;
    return route.fulfill(
      json({
        success: true,
        inviteUrl: `http://localhost:5173/invite/tok-${state.generated}-abcdefghijklmnop`,
        expiresAt: state.activeLinkExpiresAt,
      }),
    );
  });
  await page.route('**/api/invitation/revoke-link', (route) => {
    state.activeLinkExpiresAt = null;
    state.usedSlots = Math.max(0, state.usedSlots - 1);
    return route.fulfill(json({ message: 'Revoked.' }));
  });
  return state;
}

/** Passkeys on the settings screen. Removal really removes, so the list shrinks. */
export async function mockPasskeys(
  page: Page,
  items: Array<{ credentialId: string; label: string; registeredAt?: number; lastUsedAt?: number | null; backedUp?: boolean }>,
) {
  let current = items.map((i) => ({
    aaguid: null,
    registeredAt: Date.UTC(2026, 0, 12),
    lastUsedAt: null,
    backedUp: false,
    ...i,
  }));
  await page.route('**/api/auth/passkey', (route) => route.fulfill(json({ items: current })));
  await page.route('**/api/auth/passkey/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    const id = decodeURIComponent(new URL(route.request().url()).pathname.split('/').pop() ?? '');
    current = current.filter((i) => i.credentialId !== id);
    return route.fulfill(json({ message: 'Removed.' }));
  });
}

type AdminUserShape = {
  id: string;
  username: string;
  discriminator: string;
  tag: string;
  isRootUser: boolean;
  invitedByUserId: string | null;
  createdAt: number;
  isDeleted: boolean;
};

function adminUser(id: string, username: string, discriminator: string, invitedBy: string | null, extra: Partial<AdminUserShape> = {}): AdminUserShape {
  return {
    id,
    username,
    discriminator,
    tag: `${username}#${discriminator}`,
    isRootUser: false,
    invitedByUserId: invitedBy,
    createdAt: Date.UTC(2026, 2, 1),
    isDeleted: false,
    ...extra,
  };
}

/**
 * The admin screens: a small family (root → alice → carol, root → bob), one
 * pending demo request and one already approved.
 */
export async function mockAdmin(page: Page) {
  const root = adminUser('u-root', 'kutay', '0001', null, { isRootUser: true });
  const alice = adminUser('u-alice', 'alice', '0042', 'u-root');
  const bob = adminUser('u-bob', 'bob', '0007', 'u-root');
  const carol = adminUser('u-carol', 'carol', '0314', 'u-alice');
  const users = [root, alice, bob, carol];

  await page.route('**/api/admin/users', (route) => route.fulfill(json({ users, truncated: false })));
  await page.route('**/api/admin/user-tree', (route) =>
    route.fulfill(
      json({
        totalUsers: users.length,
        root: {
          ...root,
          children: [
            { ...alice, children: [{ ...carol, children: [] }] },
            { ...bob, children: [] },
          ],
        },
      }),
    ),
  );
  await page.route('**/api/admin/users/*/password/reset', (route) =>
    route.fulfill(json({ resetUrl: 'http://localhost:5173/reset/reset-token-0123456789', expiresAt: Date.now() + 1e8 })),
  );
  await page.route('**/api/admin/users/*', (route) => {
    if (route.request().method() !== 'DELETE') return route.fallback();
    return route.fulfill(json({ message: 'Deleted.' }));
  });
  await page.route('**/api/admin/demo-requests', (route) =>
    route.fulfill(
      json({
        requests: [
          {
            id: 'd-1',
            email: 'dana@example.com',
            displayName: 'Dana',
            message: 'Movie nights with my sister, who lives abroad.',
            status: 'pending',
            submittedAt: Date.UTC(2026, 8, 20),
            reviewedAt: null,
            reviewedByUserId: null,
            rejectionReason: null,
          },
          {
            id: 'd-2',
            email: 'eli@example.com',
            displayName: 'Eli',
            message: null,
            status: 'approved',
            submittedAt: Date.UTC(2026, 8, 2),
            reviewedAt: Date.UTC(2026, 8, 3),
            reviewedByUserId: 'u-root',
            rejectionReason: null,
          },
        ],
      }),
    ),
  );
  await page.route('**/api/admin/demo-requests/*/approve', (route) =>
    route.fulfill(
      json({ message: 'Approved.', inviteUrl: 'http://localhost:5173/invite/demo-invite-0123456789', expiresAt: Date.now() + 1e8 }),
    ),
  );
  await page.route('**/api/admin/demo-requests/*/reject', (route) => route.fulfill(json({ message: 'Closed.' })));
}

/** The REST half of a session: create, validate, ICE, and the one-time invite. */
export async function mockSessionApi(page: Page, sessionId = 'sess-abc123') {
  await page.route('**/api/session/create', (route) => route.fulfill(json({ sessionId })));
  await page.route(`**/api/session/${sessionId}/validate`, (route) =>
    route.fulfill(json({ exists: true, valid: true, participantCount: 0 })),
  );
  // No STUN, no TURN: nothing in these specs dials out.
  await page.route('**/api/session/ice-servers', (route) => route.fulfill(json({ iceServers: [] })));
  await page.route(`**/api/session/${sessionId}/invite`, (route) =>
    route.fulfill(
      json({
        success: true,
        inviteUrl: `http://localhost:5173/join/session-invite-${sessionId}`,
        expiresAt: new Date(Date.now() + 15 * 60 * 1000).toISOString(),
      }),
    ),
  );
  return sessionId;
}

/** One frame the room would send. Shapes mirror worker/src/lib/protocol.ts. */
export type ServerFrame = { t: string; d: unknown };

export interface SignallingMock {
  /** Every frame the page has sent, parsed. */
  sent: Array<{ t: string; d: Record<string, unknown> }>;
  /** Push a frame to the page as if the room had sent it. */
  push(frame: ServerFrame): void;
  /** Wait until the page has sent a frame of this type. */
  waitForSent(type: string): Promise<{ t: string; d: Record<string, unknown> }>;
}

/**
 * The signalling socket, played by the test.
 *
 * Answers the join with a Joined frame, echoes chat back to the sender the
 * way the real room does (the UI only shows your own message from that echo),
 * and answers the heartbeat. Everything else the page sends is recorded, and
 * the spec can push any server frame — a peer arriving, a message, a share
 * request — to drive the room screen through its states without a second
 * browser, a Durable Object or a TURN server.
 */
export async function mockSignalling(
  page: Page,
  opts: { username?: string; isOfferer?: boolean; existingPeer?: string | null } = {},
): Promise<SignallingMock> {
  const username = opts.username ?? 'alice';
  const sent: SignallingMock['sent'] = [];
  const waiters: Array<{ type: string; resolve: (f: { t: string; d: Record<string, unknown> }) => void }> = [];
  let socket: { send: (m: string) => void } | null = null;
  const pending: string[] = [];

  await page.routeWebSocket(/\/api\/session\/ws\//, (ws) => {
    socket = ws;
    if (opts.existingPeer) {
      ws.send(JSON.stringify({ t: 'ExistingPeer', d: { name: opts.existingPeer, sharing: null } }));
    }
    ws.send(
      JSON.stringify({
        t: 'Joined',
        d: { you: { userId: 'u-1', username }, isOfferer: opts.isOfferer ?? true, capacity: 2 },
      }),
    );
    for (const frame of pending.splice(0)) ws.send(frame);

    ws.onMessage((raw) => {
      const text = raw.toString();
      if (text === 'ping') {
        ws.send('pong');
        return;
      }
      let frame: { t: string; d: Record<string, unknown> };
      try {
        frame = JSON.parse(text);
      } catch {
        return;
      }
      sent.push(frame);
      if (frame.t === 'chat') {
        ws.send(
          JSON.stringify({
            t: 'ReceiveChatMessage',
            d: { sender: username, message: frame.d.m, timestamp: new Date().toISOString() },
          }),
        );
      }
      for (let i = waiters.length - 1; i >= 0; i--) {
        if (waiters[i].type === frame.t) {
          waiters[i].resolve(frame);
          waiters.splice(i, 1);
        }
      }
    });
  });

  return {
    sent,
    push(frame) {
      const text = JSON.stringify(frame);
      if (socket) socket.send(text);
      else pending.push(text);
    },
    waitForSent(type) {
      const already = sent.find((f) => f.t === type);
      if (already) return Promise.resolve(already);
      return new Promise((resolve) => waiters.push({ type, resolve }));
    },
  };
}

/**
 * The signalling room itself, played by the test for TWO real pages.
 *
 * Each page's socket is intercepted, and frames are relayed the way the
 * Durable Object relays them (worker/src/do/SessionRoom.ts): an offer from
 * one side arrives as ReceiveOffer on the other, chat is echoed to both,
 * media state and share frames go across with the sender's name. The media
 * itself then flows peer to peer for real — two Chromium pages on one
 * machine connect over host candidates, no STUN or TURN needed.
 *
 * `offerer` is who the room would make offer: the session's creator.
 */
export async function relaySignalling(pages: Array<{ page: Page; name: string }>, offerer: string) {
  type Sock = { send: (m: string) => void };
  const live = new Map<string, Sock>();
  const sent: Array<{ from: string; t: string; d: Record<string, unknown> }> = [];
  const others = (name: string) => [...live.entries()].filter(([n]) => n !== name);
  const to = (sock: Sock, t: string, d: unknown) => sock.send(JSON.stringify({ t, d }));

  for (const { page, name } of pages) {
    await page.routeWebSocket(/\/api\/session\/ws\//, (ws) => {
      for (const [otherName, otherSock] of others(name)) {
        to(ws, 'ExistingPeer', { name: otherName, sharing: null });
        to(otherSock, 'PeerJoined', { name });
      }
      live.set(name, ws);
      to(ws, 'Joined', { you: { userId: `u-${name}`, username: name }, isOfferer: name === offerer, capacity: 2 });

      ws.onMessage((raw) => {
        const text = raw.toString();
        if (text === 'ping') {
          ws.send('pong');
          return;
        }
        let f: { t: string; d: Record<string, unknown> };
        try {
          f = JSON.parse(text);
        } catch {
          return;
        }
        sent.push({ from: name, ...f });
        const peer = others(name)[0]?.[1];
        switch (f.t) {
          case 'chat': {
            const msg = { sender: name, message: f.d.m, timestamp: new Date().toISOString() };
            to(ws, 'ReceiveChatMessage', msg);
            if (peer) to(peer, 'ReceiveChatMessage', msg);
            break;
          }
          case 'offer':
            if (peer) to(peer, 'ReceiveOffer', { sdp: f.d.sdp, name });
            break;
          case 'answer':
            if (peer) to(peer, 'ReceiveAnswer', { sdp: f.d.sdp });
            break;
          case 'ice':
            if (peer) to(peer, 'ReceiveIceCandidate', { c: f.d.c });
            break;
          case 'reoffer':
            if (peer) to(peer, 'ReceiveRenegotiationOffer', { sdp: f.d.sdp });
            break;
          case 'reanswer':
            if (peer) to(peer, 'ReceiveRenegotiationAnswer', { sdp: f.d.sdp });
            break;
          case 'media':
            if (peer) to(peer, 'PeerMediaStateChanged', { name, state: f.d });
            break;
          case 'ss:req':
            if (peer) to(peer, 'ScreenShareRequested', { name });
            break;
          case 'ss:res':
            if (peer) to(peer, 'ScreenShareResponse', { approved: f.d.approved, name });
            break;
          case 'ss:start':
            if (peer) to(peer, 'ScreenShareStarted', { name, streamId: f.d.streamId });
            break;
          case 'ss:stop':
            if (peer) to(peer, 'ScreenShareStopped', { name });
            break;
          case 'leave':
            live.delete(name);
            if (peer) to(peer, 'PeerLeft', { name });
            break;
        }
      });
    });
  }
  return { sent };
}

/**
 * Everything the room screen needs, for a signed-in user arriving at a fresh
 * session: identity, the session API and the signalling socket. Returns the
 * socket so the spec can play the other person.
 */
export async function enterSession(page: Page, opts: { username?: string; sessionId?: string } = {}) {
  const username = opts.username ?? 'alice';
  await mockLoggedInUser(page, { username, tag: `${username}#0042` });
  const sessionId = await mockSessionApi(page, opts.sessionId);
  const signalling = await mockSignalling(page, { username });
  return { sessionId, signalling };
}

/**
 * Wait until every finite animation on the page has finished — entrances,
 * fades, springs. Infinite ones (film grain, a live dot) are ignored, and the
 * canvas loops are not Web Animations at all. For screenshots meant to show
 * the settled screen rather than a frame of its entrance.
 */
export async function settle(page: Page, timeout = 4000) {
  await expect
    .poll(
      () =>
        page.evaluate(
          () =>
            document
              .getAnimations()
              .filter((a) => a.playState === 'running' && a.effect?.getTiming().iterations !== Infinity).length,
        ),
      { timeout },
    )
    .toBe(0);
  // motion drives some values (filters among them) per frame rather than
  // through WAAPI; two frames is enough for the last of those to land.
  await page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
  await page.waitForTimeout(250);
}

/** No page may be wider than the screen it is on. */
export async function expectNoHorizontalOverflow(page: Page) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow, 'page scrolls sideways').toBeLessThanOrEqual(0);
}
