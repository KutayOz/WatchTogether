import { test, expect } from '@playwright/test';
import {
  disableAnimations,
  expectPathname,
  mockLobby,
  mockLoggedInUser,
  mockSessionApi,
} from './helpers';

/**
 * The lobby: the screen to start a session from, the paste-a-link box, and
 * the invite book with its modal.
 */
test.describe('Lobby', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedInUser(page);
  });

  test('greets the signed-in person by name and offers the one main action', async ({ page }) => {
    await mockLobby(page);
    await page.goto('/');

    await expect(page.getByRole('heading', { level: 1 })).toHaveAccessibleName(
      /^(good morning|good afternoon|good evening|up late), alice$/i,
    );
    await expect(page.getByRole('button', { name: /start a session/i })).toBeEnabled();
    // The top bar says who is signed in and where you can go.
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByText('alice#0042')).toBeVisible();
  });

  test('draws the invite book: spent tickets and the ones still to give', async ({ page }) => {
    await mockLobby(page, { maxSlots: 3, usedSlots: 1 });
    await page.goto('/');

    await expect(page.getByText('2 of 3 left')).toBeVisible();
    // One used stub, two tickets that can be torn off.
    await expect(page.getByText('Given away')).toHaveCount(1);
    await expect(page.getByRole('button', { name: /make an invite link/i })).toHaveCount(2);
  });

  test('root has no cap: one fresh ticket, labelled unlimited', async ({ page }) => {
    await mockLobby(page, { maxSlots: null, usedSlots: 4 });
    await page.goto('/');

    await expect(page.getByText('Unlimited')).toBeVisible();
    await expect(page.getByRole('button', { name: /make an invite link/i })).toHaveCount(1);
  });

  test('starting a session goes to the device check for that session', async ({ page }) => {
    await mockLobby(page);
    const sessionId = await mockSessionApi(page);
    await page.goto('/');

    await page.getByRole('button', { name: /start a session/i }).click();

    await expectPathname(page, `/session/${sessionId}`);
    await expect(page.getByRole('heading', { name: /check your picture and sound/i })).toBeVisible();
    await expect(page.getByText('Starting a new session')).toBeVisible();
  });

  test('says why a session could not be started', async ({ page }) => {
    await mockLobby(page);
    await page.route('**/api/session/create', (route) =>
      route.fulfill({ status: 429, contentType: 'application/json', body: JSON.stringify({ message: 'Slow down a little.' }) }),
    );
    await page.goto('/');

    await page.getByRole('button', { name: /start a session/i }).click();

    await expect(page.getByRole('alert')).toContainText('Slow down a little.');
    await expect(page.getByRole('button', { name: /start a session/i })).toBeEnabled();
    await expectPathname(page, '/');
  });
});

test.describe('Joining with a pasted link', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedInUser(page);
    await mockLobby(page);
    await page.goto('/');
  });

  test('refuses a link from another site — the phishing guard', async ({ page }) => {
    await page.getByLabel('Session link').fill('https://evil.example/join/attacker-token');
    await page.getByRole('button', { name: /^join$/i }).click();

    await expect(page.getByText(/for a different site/i)).toBeVisible();
    await expectPathname(page, '/');
  });

  test('explains a link that is not a session link', async ({ page }) => {
    await page.getByLabel('Session link').fill('http://localhost:5173/settings');
    await page.getByRole('button', { name: /^join$/i }).click();

    await expect(page.getByText(/doesn.t look like a session link/i)).toBeVisible();
  });

  test('follows a real join link, and Enter works as well as the button', async ({ page }) => {
    await page.route('**/api/session/invite/*/validate', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ valid: true, creatorDisplayName: 'bob' }) }),
    );
    await page.getByLabel('Session link').fill('http://localhost:5173/join/tok-123');
    await page.getByLabel('Session link').press('Enter');

    await expectPathname(page, '/join/tok-123');
    await expect(page.getByRole('heading', { name: /bob saved you a seat/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /join session/i })).toBeVisible();
  });
});

test.describe('Invite modal', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write', 'camera', 'microphone'] });

  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedInUser(page);
  });

  test('makes a one-time link, copies it, and spends a ticket', async ({ page }) => {
    await mockLobby(page, { maxSlots: 3, usedSlots: 1 });
    await page.goto('/');

    await page.getByRole('button', { name: /make an invite link/i }).first().click();

    const dialog = page.getByRole('dialog', { name: /invite someone new/i });
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('2 left')).toBeVisible();

    await dialog.getByRole('button', { name: /make invite link/i }).click();

    await expect(page.getByRole('dialog', { name: /your invite is ready/i })).toBeVisible();
    await expect(page.getByText('http://localhost:5173/invite/tok-1-abcdefghijklmnop')).toBeVisible();
    await expect(page.getByText(/expires in 47h/i)).toBeVisible();

    await page.getByRole('button', { name: /copy link/i }).click();
    await expect(page.getByRole('button', { name: /^copied$/i })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
      'http://localhost:5173/invite/tok-1-abcdefghijklmnop',
    );

    // The book underneath now shows the spent ticket.
    await page.getByRole('button', { name: /^done$/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByText('1 of 3 left')).toBeVisible();
  });

  test('an outstanding link has to be revoked before another is made', async ({ page }) => {
    await mockLobby(page, { maxSlots: 3, usedSlots: 1, activeLinkExpiresAt: Date.now() + 5 * 3600 * 1000 });
    await page.goto('/');

    await page.getByRole('button', { name: /make an invite link/i }).first().click();
    const dialog = page.getByRole('dialog', { name: /invite someone new/i });

    await expect(dialog.getByText(/you already have a link out/i)).toBeVisible();
    await expect(dialog.getByRole('button', { name: /make invite link/i })).toBeDisabled();

    await dialog.getByRole('button', { name: /revoke it/i }).click();

    await expect(dialog.getByText(/you already have a link out/i)).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: /make invite link/i })).toBeEnabled();
  });

  test('closes on Escape and hands focus back to the ticket that opened it', async ({ page }) => {
    await mockLobby(page);
    await page.goto('/');

    const ticket = page.getByRole('button', { name: /make an invite link/i }).first();
    await ticket.click();
    await expect(page.getByRole('dialog')).toBeVisible();

    await page.keyboard.press('Escape');

    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(ticket).toBeFocused();
  });

  test('keeps Tab inside the dialog while it is open', async ({ page }) => {
    await mockLobby(page);
    await page.goto('/');
    await page.getByRole('button', { name: /make an invite link/i }).first().click();
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();

    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('Tab');
      const inside = await page.evaluate(() => !!document.activeElement?.closest('[role="dialog"]'));
      expect(inside, `focus escaped the dialog after ${i + 1} tabs`).toBe(true);
    }
  });
});

test.describe('Signed-in navigation', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
  });

  test('admin is only on the menu for root', async ({ page }) => {
    await mockLoggedInUser(page, { isRootUser: false });
    await mockLobby(page);
    await page.goto('/');
    await expect(page.getByRole('link', { name: /settings/i })).toBeVisible();
    await expect(page.getByRole('link', { name: /admin/i })).toHaveCount(0);
  });

  test('root sees the admin link and it leads there', async ({ page }) => {
    await mockLoggedInUser(page, { isRootUser: true, username: 'kutay', tag: 'kutay#0001' });
    await mockLobby(page, { maxSlots: null });
    await page.route('**/api/admin/**', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ users: [], requests: [], root: null, totalUsers: 0 }) }),
    );
    await page.goto('/');

    await page.getByRole('link', { name: /admin/i }).click();
    await expectPathname(page, '/admin');
    await expect(page.getByRole('heading', { name: /^admin$/i })).toBeVisible();
    // The current page is marked in the nav.
    await expect(page.getByRole('link', { name: /admin/i })).toHaveAttribute('aria-current', 'page');
  });

  test('signing out returns to the sign-in screen', async ({ page }) => {
    await mockLoggedInUser(page);
    await mockLobby(page);
    await page.route('**/api/auth/logout', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: '{}' }),
    );
    await page.route('**/api/auth/setup/status', (route) =>
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ isSetupComplete: true }) }),
    );
    await page.goto('/');

    await page.getByRole('button', { name: /sign out/i }).click();

    await expectPathname(page, '/login');
    await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();
  });
});
