import { test, expect } from '@playwright/test';
import { disableAnimations, expectPathname, mockAdmin, mockLobby, mockLoggedInUser, mockPasskeys } from './helpers';

test.describe('Settings', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedInUser(page);
  });

  test('lists passkeys with when they were added and last used', async ({ page }) => {
    await mockPasskeys(page, [
      { credentialId: 'cred-1', label: 'Mac (Touch ID)', lastUsedAt: Date.UTC(2026, 8, 20), backedUp: true },
      { credentialId: 'cred-2', label: 'YubiKey' },
    ]);
    await page.goto('/settings');

    await expect(page.getByRole('heading', { name: /^settings$/i })).toBeVisible();
    await expect(page.getByRole('main').getByText('alice#0042')).toBeVisible();
    await expect(page.getByText('Mac (Touch ID)')).toBeVisible();
    await expect(page.getByText('YubiKey')).toBeVisible();
    await expect(page.getByText('Synced')).toHaveCount(1);
    await expect(page.getByText(/last used/i)).toHaveCount(1);
  });

  test('removing a passkey asks first, in a dialog rather than confirm()', async ({ page }) => {
    await mockPasskeys(page, [
      { credentialId: 'cred-1', label: 'Mac (Touch ID)' },
      { credentialId: 'cred-2', label: 'YubiKey' },
    ]);
    await page.goto('/settings');

    await page.getByRole('button', { name: 'Remove passkey YubiKey' }).click();
    const dialog = page.getByRole('dialog', { name: /remove this passkey/i });
    await expect(dialog).toContainText('YubiKey');

    // Keeping it changes nothing.
    await dialog.getByRole('button', { name: /keep it/i }).click();
    await expect(page.getByRole('dialog')).toHaveCount(0);
    await expect(page.getByRole('listitem').filter({ hasText: 'YubiKey' })).toBeVisible();

    await page.getByRole('button', { name: 'Remove passkey YubiKey' }).click();
    await page.getByRole('dialog').getByRole('button', { name: /^remove$/i }).click();

    await expect(page.getByRole('status').filter({ hasText: /removed “yubikey”/i })).toBeVisible();
    await expect(page.getByRole('listitem').filter({ hasText: 'YubiKey' })).toHaveCount(0);
    await expect(page.getByText('Mac (Touch ID)')).toBeVisible();
  });

  test('an empty list says what to do about it', async ({ page }) => {
    await mockPasskeys(page, []);
    await page.goto('/settings');
    await expect(page.getByText('No passkeys yet')).toBeVisible();
    await expect(page.getByRole('button', { name: /add a passkey/i })).toBeEnabled();
  });
});

test.describe('Admin', () => {
  test.use({ permissions: ['clipboard-read', 'clipboard-write', 'camera', 'microphone'] });

  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
  });

  test('is not for anyone but root', async ({ page }) => {
    await mockLoggedInUser(page, { isRootUser: false });
    await mockLobby(page);
    await page.goto('/admin');
    await expectPathname(page, '/');
  });

  test.describe('as root', () => {
    test.beforeEach(async ({ page }) => {
      await mockLoggedInUser(page, { isRootUser: true, username: 'kutay', tag: 'kutay#0001' });
      await mockAdmin(page);
      await page.goto('/admin');
    });

    test('draws who invited whom, and branches fold', async ({ page }) => {
      const tree = page.getByRole('tree', { name: 'Invite tree' });
      await expect(tree).toBeVisible();
      await expect(tree.getByRole('treeitem', { name: 'carol#0314' })).toBeVisible();

      const alice = tree.getByRole('treeitem', { name: 'alice#0042' });
      await expect(alice).toHaveAttribute('aria-expanded', 'true');
      await page.getByRole('button', { name: /fold alice’s invites/i }).click();
      await expect(alice).toHaveAttribute('aria-expanded', 'false');
      await expect(tree.getByRole('treeitem', { name: 'carol#0314' })).toHaveCount(0);

      await page.getByRole('button', { name: /show alice’s invites/i }).click();
      await expect(tree.getByRole('treeitem', { name: 'carol#0314' })).toBeVisible();
    });

    test('tabs switch sections and carry their counts', async ({ page }) => {
      await expect(page.getByRole('tab', { name: /invite tree/i })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('tab', { name: /people/i })).toContainText('4');
      await expect(page.getByRole('tab', { name: /requests/i })).toContainText('1');

      await page.getByRole('tab', { name: /people/i }).click();
      await expect(page.getByRole('tab', { name: /people/i })).toHaveAttribute('aria-selected', 'true');
      await expect(page.getByRole('table', { name: 'People' })).toBeVisible();
      await expect(page.getByRole('row')).toHaveCount(5); // header + four people
    });

    test('a reset link is shown once and copies', async ({ page }) => {
      await page.getByRole('tab', { name: /people/i }).click();
      await page.getByRole('row').filter({ hasText: 'bob#0007' }).getByRole('button', { name: /reset password/i }).click();

      const dialog = page.getByRole('dialog', { name: /reset link/i });
      await expect(dialog).toContainText('bob#0007');
      await expect(dialog.getByText('http://localhost:5173/reset/reset-token-0123456789')).toBeVisible();
      await dialog.getByRole('button', { name: /copy link/i }).click();
      await expect(dialog.getByRole('button', { name: /^copied$/i })).toBeVisible();
      expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(
        'http://localhost:5173/reset/reset-token-0123456789',
      );
    });

    test('root cannot be deleted; anyone else asks before going', async ({ page }) => {
      await page.getByRole('tab', { name: /people/i }).click();
      await expect(page.getByRole('row').filter({ hasText: 'kutay#0001' }).getByRole('button', { name: /delete/i })).toHaveCount(0);

      let deleted = false;
      page.on('request', (r) => {
        if (r.method() === 'DELETE' && r.url().includes('/api/admin/users/u-bob')) deleted = true;
      });
      await page.getByRole('row').filter({ hasText: 'bob#0007' }).getByRole('button', { name: /delete/i }).click();
      const dialog = page.getByRole('dialog', { name: /delete this person/i });
      await expect(dialog).toContainText(/can.t be undone/i);
      await dialog.getByRole('button', { name: /^delete$/i }).click();
      await expect.poll(() => deleted).toBe(true);
    });

    test('approving a request shows its invite link once', async ({ page }) => {
      await page.getByRole('tab', { name: /requests/i }).click();
      const request = page.getByRole('article', { name: /request from dana/i });
      await expect(request).toContainText('Movie nights with my sister');
      await expect(request.getByRole('link', { name: /dana@example.com/i })).toHaveAttribute('href', 'mailto:dana@example.com');

      await request.getByRole('button', { name: /approve and make link/i }).click();
      const dialog = page.getByRole('dialog', { name: /invite link/i });
      await expect(dialog.getByText('http://localhost:5173/invite/demo-invite-0123456789')).toBeVisible();
      await expect(dialog).toContainText(/closing this is the last/i);
    });

    test('closing a request takes an optional note', async ({ page }) => {
      let body: unknown = null;
      await page.route('**/api/admin/demo-requests/*/reject', async (route) => {
        body = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{"message":"ok"}' });
      });
      await page.getByRole('tab', { name: /requests/i }).click();
      await page.getByRole('article', { name: /request from dana/i }).getByRole('button', { name: /not now/i }).click();

      const dialog = page.getByRole('dialog', { name: /close this request/i });
      await dialog.getByLabel(/a note for yourself/i).fill('Full for now.');
      await dialog.getByRole('button', { name: /close request/i }).click();
      await expect.poll(() => body).toEqual({ reason: 'Full for now.' });
    });
  });
});
