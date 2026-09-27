import { test, expect } from '@playwright/test';
import { disableAnimations, expectPathname, mockLoggedOut, mockSetupStatus } from './helpers';

/**
 * The way in for somebody with no invite: a note for root, answered by hand.
 * It files a request and mints nothing, so all there is to check is that the
 * note gets filed and the person is told honestly what happens next.
 */
test.describe('Requesting a demo', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
  });

  test('is one footnote away from sign-in', async ({ page }) => {
    await page.goto('/login');
    await page.getByRole('link', { name: /request a demo/i }).click();
    await expectPathname(page, '/request-demo');
    await expect(page.getByRole('heading', { name: /ask for a seat/i })).toBeVisible();
  });

  test('files the request and says who will answer, and where', async ({ page }) => {
    let body: unknown = null;
    await page.route('**/api/demo-requests', async (route) => {
      body = route.request().postDataJSON();
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ message: 'ok' }) });
    });
    await page.goto('/request-demo');

    await page.getByLabel('Your name').fill('Dana');
    await page.getByLabel('Email').fill('dana@example.com');
    await page.getByLabel(/why do you want to try it/i).fill('Movie nights with my sister.');
    await expect(page.getByText('28 / 500')).toBeVisible();
    await page.getByRole('button', { name: /send request/i }).click();

    await expect(page.getByRole('heading', { name: /it’s in the pile/i })).toBeVisible();
    await expect(page.getByText('dana@example.com')).toBeVisible();
    expect(body).toEqual({ email: 'dana@example.com', displayName: 'Dana', message: 'Movie nights with my sister.' });
  });

  test('catches an address that cannot be replied to, before sending', async ({ page }) => {
    let calls = 0;
    await page.route('**/api/demo-requests', async (route) => {
      calls++;
      await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
    });
    await page.goto('/request-demo');

    await page.getByLabel('Your name').fill('Dana');
    await page.getByLabel('Email').fill('dana@nowhere');
    // The browser's own email check would block submit; skip it to reach ours.
    await page.locator('form').evaluate((f: HTMLFormElement) => (f.noValidate = true));
    await page.getByRole('button', { name: /send request/i }).click();

    await expect(page.getByRole('alert')).toContainText(/looks off/i);
    expect(calls).toBe(0);
  });
});
