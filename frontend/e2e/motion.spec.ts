import { test, expect, type Page } from '@playwright/test';
import { enterSession, mockLoggedOut, mockSetupStatus } from './helpers';

/**
 * The JavaScript half of the design, checked for actually running — and for
 * standing down when someone asks their OS for less motion.
 *
 * Deliberately NOT using disableAnimations: that emulates reduced motion,
 * which is the very thing half of these tests are about.
 */

/** A cheap fingerprint of what a canvas is showing right now. */
function canvasFingerprint(page: Page, selector: string) {
  return page.locator(selector).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext('2d');
    if (!ctx || !c.width || !c.height) return '';
    const { data } = ctx.getImageData(0, 0, c.width, c.height);
    let hash = 0;
    for (let i = 0; i < data.length; i += 97) hash = (hash * 31 + data[i]) | 0;
    return String(hash);
  });
}

async function openLogin(page: Page) {
  await mockLoggedOut(page);
  await mockSetupStatus(page, true);
  await page.goto('/login');
  await expect(page.getByRole('button', { name: /sign in with a passkey/i })).toBeVisible();
}

test.describe('with motion', () => {
  test('the projector on the sign-in screen is live', async ({ page }) => {
    await openLogin(page);
    const first = await canvasFingerprint(page, '.theater__canvas');
    await page.waitForTimeout(700);
    const second = await canvasFingerprint(page, '.theater__canvas');
    expect(first).not.toBe('');
    expect(second).not.toBe(first);
  });

  test('your light follows the cursor across the screen', async ({ page }) => {
    await openLogin(page);
    const screen = page.locator('.theater__screen');
    const box = (await screen.boundingBox())!;
    const spill = () => screen.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--spill-a')));

    await page.mouse.move(box.x + box.width * 0.05, box.y + box.height / 2);
    await expect.poll(spill, { timeout: 5000 }).toBeLessThan(20);
    await page.mouse.move(box.x + box.width * 0.95, box.y + box.height / 2, { steps: 8 });
    await expect.poll(spill, { timeout: 5000 }).toBeGreaterThan(80);
  });

  test('the title comes into focus rather than just appearing', async ({ page }) => {
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
    // Record the title's blur every frame from the very start, so catching
    // the soft phase does not depend on how fast the test gets to look.
    await page.addInitScript(() => {
      const w = window as unknown as { __maxBlur: number };
      w.__maxBlur = 0;
      const sample = () => {
        const span = document.querySelector('.theater__title h1 span');
        if (span) {
          const m = getComputedStyle(span).filter.match(/blur\(([\d.]+)px\)/);
          if (m) w.__maxBlur = Math.max(w.__maxBlur, parseFloat(m[1]));
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    });
    await page.goto('/login');
    const word = page.getByRole('heading', { name: 'WatchTogether' }).locator('span').first();
    // It started soft…
    await expect
      .poll(() => page.evaluate(() => (window as unknown as { __maxBlur: number }).__maxBlur), { timeout: 5000 })
      .toBeGreaterThan(4);
    // …and it settles sharp.
    await expect
      .poll(() => word.evaluate((el) => getComputedStyle(el).filter), { timeout: 5000 })
      .toMatch(/^(none|blur\(0px\))$/);
  });

  test('the main button leans toward the cursor and lights where it is', async ({ page }) => {
    await openLogin(page);
    const button = page.getByRole('button', { name: /sign in with a passkey/i });
    await expect.poll(async () => (await button.boundingBox())?.y, { timeout: 5000 }).toBeGreaterThan(0);
    await page.waitForTimeout(1200); // entrance done
    const box = (await button.boundingBox())!;

    // Inside the capsule's straight edge — its rounded ends are not part of
    // it for hit testing.
    await page.mouse.move(box.x + box.width - 40, box.y + 10, { steps: 4 });
    await expect(button).toHaveAttribute('data-lit');
    await expect.poll(() => button.evaluate((el) => (el as HTMLElement).style.translate)).not.toBe('');
    const translate = await button.evaluate((el) => (el as HTMLElement).style.translate);
    const [dx, dy] = translate.split(' ').map(parseFloat);
    expect(dx).toBeGreaterThan(0); // toward the right edge
    expect(dy).toBeLessThan(0); // toward the top

    // And lets go when the cursor leaves.
    await page.mouse.move(5, 5, { steps: 4 });
    await expect.poll(() => button.evaluate((el) => (el as HTMLElement).style.translate)).toBe('');
    await expect(button).not.toHaveAttribute('data-lit', '');
  });

  test('pressing a button throws a ring of light from the press point', async ({ page }) => {
    await openLogin(page);
    await page.getByLabel('Handle').fill('alice#0042');
    await page.getByLabel('Password', { exact: true }).fill('orbital-teapot-42');
    const button = page.getByRole('button', { name: /sign in with a password/i });
    await expect(button).toBeEnabled();

    // hover() waits for the sheet's entrance to finish moving the button.
    // Then press without releasing on it, so no sign-in is attempted.
    await button.hover({ position: { x: 40, y: 20 } });
    await page.mouse.down();
    await expect(button.locator('.ripple-layer')).toHaveCount(1);
    await page.mouse.move(5, 5);
    await page.mouse.up();
    // It cleans up after itself.
    await expect(button.locator('.ripple-layer')).toHaveCount(0, { timeout: 3000 });
  });

  test('a mistake shakes', async ({ page }) => {
    await mockLoggedOut(page);
    await mockSetupStatus(page, true);
    await page.route('**/api/auth/password/login', (route) =>
      route.fulfill({ status: 401, contentType: 'application/json', body: JSON.stringify({ message: 'That handle and password do not match.' }) }),
    );
    await page.goto('/login');
    await page.getByLabel('Handle').fill('alice#0042');
    await page.getByLabel('Password', { exact: true }).fill('not-the-right-one');
    await page.getByRole('button', { name: /sign in with a password/i }).click();

    const alert = page.getByRole('alert');
    await expect(alert).toBeVisible({ timeout: 10_000 });
    const shaking = await alert.evaluate((el) =>
      el.getAnimations().some((a) => JSON.stringify((a.effect as KeyframeEffect).getKeyframes()).includes('translateX')),
    );
    expect(shaking).toBe(true);
  });

  test('the device check glows with your own picture and your voice', async ({ page }) => {
    const { sessionId } = await enterSession(page);
    await page.goto(`/session/${sessionId}`);
    const preview = page.locator('.preview');
    await expect(page.getByRole('button', { name: /^join$/i })).toBeEnabled({ timeout: 15_000 });

    // Ambient light: the room around the preview takes the camera's colour —
    // the fake camera is green, so the sampled light is too.
    await expect
      .poll(
        () =>
          preview.evaluate((el) => {
            const m = getComputedStyle(el).getPropertyValue('--amb-l').match(/\d+/g)?.map(Number) ?? [0, 0, 0];
            return m[1] > m[0] && m[1] > m[2];
          }),
        { timeout: 8000 },
      )
      .toBe(true);

    // Voice: the fake mic beeps, and each beep lifts --level.
    await expect
      .poll(() => preview.evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--level')) || 0), {
        timeout: 8000,
      })
      .toBeGreaterThan(0.05);

    // And the oscilloscope is drawing.
    const a = await canvasFingerprint(page, '.wave__canvas');
    await page.waitForTimeout(400);
    const b = await canvasFingerprint(page, '.wave__canvas');
    expect(b).not.toBe(a);
  });

  test('joining counts down on a film leader', async ({ page }) => {
    const { sessionId } = await enterSession(page);
    // Hold the join open long enough to watch the leader go round.
    await page.route(`**/api/session/${sessionId}/validate`, async (route) => {
      await new Promise((r) => setTimeout(r, 2600));
      await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ exists: true, valid: true, participantCount: 0 }) });
    });
    await page.goto(`/session/${sessionId}`);
    await page.getByRole('button', { name: /^join$/i }).click({ timeout: 15_000 });

    const leader = page.getByRole('status').filter({ hasText: /joining the session/i });
    await expect(leader).toBeVisible();
    const number = page.locator('.leader__num');
    const seen = new Set<string>();
    for (let i = 0; i < 12; i++) {
      seen.add((await number.textContent()) ?? '');
      await page.waitForTimeout(150);
    }
    expect(seen.size).toBeGreaterThan(1);
    await expect(page.getByText(/waiting for someone to join/i)).toBeVisible({ timeout: 10_000 });
  });
});

test.describe('with reduced motion', () => {
  test.use({ contextOptions: { reducedMotion: 'reduce' } });

  test('the projector holds a single still frame', async ({ page }) => {
    await openLogin(page);
    await page.waitForTimeout(300);
    const first = await canvasFingerprint(page, '.theater__canvas');
    await page.waitForTimeout(700);
    expect(await canvasFingerprint(page, '.theater__canvas')).toBe(first);
  });

  test('nothing leans, ripples or blurs', async ({ page }) => {
    await openLogin(page);
    const button = page.getByRole('button', { name: /sign in with a passkey/i });
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width - 6, box.y + 6, { steps: 3 });
    await page.waitForTimeout(200);
    expect(await button.evaluate((el) => (el as HTMLElement).style.translate)).toBe('');

    await page.mouse.down();
    await expect(button.locator('.ripple-layer')).toHaveCount(0);
    await page.mouse.move(5, 5);
    await page.mouse.up();

    const word = page.getByRole('heading', { name: 'WatchTogether' }).locator('span').first();
    expect(await word.evaluate((el) => getComputedStyle(el).filter)).toBe('none');
  });
});
