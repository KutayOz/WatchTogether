import { test, expect, type Page } from '@playwright/test';
import {
  disableAnimations,
  enterSession,
  expectNoHorizontalOverflow,
  mockAdmin,
  mockInviteLink,
  mockLobby,
  mockLoggedInUser,
  mockLoggedOut,
  mockPasskeys,
  mockSetupStatus,
  settle,
} from './helpers';

/**
 * Every screen at a phone, a tablet and a desk: nothing scrolls sideways, the
 * thing the screen is for is on it, and a screenshot of each lands in
 * test-results/ for a person to look at. The screenshots are evidence for
 * review, not baselines — nothing here diffs pixels.
 */

const VIEWPORTS = [
  { name: 'phone', width: 375, height: 812 },
  { name: 'tablet', width: 768, height: 1024 },
  { name: 'desk', width: 1440, height: 900 },
] as const;

type Screen = {
  name: string;
  setup: (page: Page) => Promise<string>;
  ready: (page: Page) => ReturnType<Page['getByRole']>;
};

const SCREENS: Screen[] = [
  {
    name: 'login',
    setup: async (page) => {
      await mockLoggedOut(page);
      await mockSetupStatus(page, true);
      return '/login';
    },
    ready: (page) => page.getByRole('button', { name: /sign in with a passkey/i }),
  },
  {
    name: 'request-demo',
    setup: async (page) => {
      await mockLoggedOut(page);
      return '/request-demo';
    },
    ready: (page) => page.getByRole('button', { name: /send request/i }),
  },
  {
    name: 'invite-signup',
    setup: async (page) => {
      await mockLoggedOut(page);
      await mockInviteLink(page, true);
      return '/invite/some-token';
    },
    ready: (page) => page.getByRole('button', { name: /create account/i }),
  },
  {
    name: 'lobby',
    setup: async (page) => {
      await mockLoggedInUser(page);
      await mockLobby(page);
      return '/';
    },
    ready: (page) => page.getByRole('button', { name: /start a session/i }),
  },
  {
    name: 'settings',
    setup: async (page) => {
      await mockLoggedInUser(page);
      await mockPasskeys(page, [{ credentialId: 'c1', label: 'Mac (Touch ID)', backedUp: true }]);
      return '/settings';
    },
    ready: (page) => page.getByRole('button', { name: /add a passkey/i }),
  },
  {
    name: 'admin',
    setup: async (page) => {
      await mockLoggedInUser(page, { isRootUser: true, username: 'kutay', tag: 'kutay#0001' });
      await mockAdmin(page);
      return '/admin';
    },
    ready: (page) => page.getByRole('tab', { name: /people/i }),
  },
  {
    name: 'device-check',
    setup: async (page) => {
      const { sessionId } = await enterSession(page);
      return `/session/${sessionId}`;
    },
    ready: (page) => page.getByRole('button', { name: /^join$/i }),
  },
];

for (const vp of VIEWPORTS) {
  test.describe(`${vp.name} (${vp.width}×${vp.height})`, () => {
    test.use({ viewport: { width: vp.width, height: vp.height } });

    test.beforeEach(async ({ page }) => {
      await disableAnimations(page);
    });

    for (const screen of SCREENS) {
      test(`${screen.name} fits and shows its main action`, async ({ page }, testInfo) => {
        const url = await screen.setup(page);
        await page.goto(url);
        await expect(screen.ready(page)).toBeVisible({ timeout: 15_000 });
        // Below the fold is fine on a short phone, as long as it is reachable
        // and fully usable once there.
        await screen.ready(page).scrollIntoViewIfNeeded();
        await expect(screen.ready(page)).toBeInViewport({ ratio: 1 });
        await expectNoHorizontalOverflow(page);
        await settle(page);
        await page.screenshot({ path: testInfo.outputPath(`${vp.name}-${screen.name}.png`), fullPage: true });
      });
    }

    test('room: stage, dock and people all on screen', async ({ page }, testInfo) => {
      const { sessionId, signalling } = await enterSession(page);
      await page.goto(`/session/${sessionId}`);
      await page.getByRole('button', { name: /^join$/i }).click({ timeout: 15_000 });
      await expect(page.getByText(/waiting for someone to join/i)).toBeVisible();

      signalling.push({ t: 'PeerJoined', d: { name: 'bob' } });
      signalling.push({
        t: 'ReceiveChatMessage',
        d: { sender: 'bob', message: 'hey, is this thing on?', timestamp: new Date().toISOString() },
      });
      await expect(page.getByText('With bob')).toBeVisible();

      const dock = page.getByRole('toolbar', { name: 'Call controls' });
      await expect(dock).toBeInViewport();
      const box = await dock.boundingBox();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(vp.width);
      // The room is exactly one screen tall: nothing to scroll past.
      expect(await page.evaluate(() => document.documentElement.scrollHeight)).toBeLessThanOrEqual(vp.height);
      await expectNoHorizontalOverflow(page);
      // The arrival toast is a moment, not part of the layout under review.
      await page.getByRole('button', { name: /dismiss notification/i }).click();
      await settle(page);
      await page.screenshot({ path: testInfo.outputPath(`${vp.name}-room.png`) });

      if (vp.width < 1024) {
        await page.getByRole('button', { name: /show chat/i }).click();
        await expect(page.getByRole('log', { name: 'Messages' }).getByText('hey, is this thing on?')).toBeInViewport();
        await settle(page);
        await page.screenshot({ path: testInfo.outputPath(`${vp.name}-room-chat.png`) });
      }
    });
  });
}
