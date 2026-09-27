import { test, expect, type Browser, type Page } from '@playwright/test';
import { mockLoggedInUser, mockSessionApi, relaySignalling } from './helpers';

/**
 * A real call between two browsers.
 *
 * Two Chromium contexts — alice and bob, each with a fake camera and mic —
 * join one session. The test plays the signalling room (relaySignalling), and
 * everything after that is real: the offer/answer, ICE over host candidates,
 * the media, and the DataChannel that carries reactions and typing. So this
 * is where the screens that only exist in a live call get checked: the other
 * person filling the stage, your own window in the corner, their voice
 * lighting the frame, reactions flying across.
 */

const SESSION = 'sess-live';

async function person(browser: Browser, name: string, width = 1280, height = 800) {
  const context = await browser.newContext({
    permissions: ['camera', 'microphone'],
    viewport: { width, height },
  });
  const page = await context.newPage();
  await mockLoggedInUser(page, { username: name, tag: `${name}#00${name.length}1` });
  await mockSessionApi(page, SESSION);
  return page;
}

async function join(page: Page) {
  await page.goto(`/session/${SESSION}`);
  await page.getByRole('button', { name: /^join$/i }).click({ timeout: 20_000 });
  await expect(page.locator('.room')).toBeVisible({ timeout: 20_000 });
}

const connected = (page: Page) => page.locator('.room-top__state[data-state="connected"]');

test.describe('A call between two people', () => {
  test.describe.configure({ mode: 'serial' });

  test('they connect, see each other, and everything in between works', async ({ browser }) => {
    test.slow();
    const alice = await person(browser, 'alice');
    const bob = await person(browser, 'bob');
    const relay = await relaySignalling(
      [
        { page: alice, name: 'alice' },
        { page: bob, name: 'bob' },
      ],
      'alice',
    );

    await join(alice);
    await expect(alice.getByText(/waiting for someone to join/i)).toBeVisible();
    await join(bob);

    // ── arrival ───────────────────────────────────────────────────────────
    await expect(alice.getByText('With bob')).toBeVisible();
    await expect(bob.getByText('With alice')).toBeVisible();
    await expect(connected(alice)).toBeVisible({ timeout: 20_000 });
    await expect(connected(bob)).toBeVisible({ timeout: 20_000 });
    expect(relay.sent.some((f) => f.from === 'alice' && f.t === 'offer')).toBe(true);
    expect(relay.sent.some((f) => f.from === 'bob' && f.t === 'answer')).toBe(true);

    // The other person fills the stage, playing real frames.
    const bigPicture = alice.locator('.stage--peer > video');
    await expect
      .poll(() => bigPicture.evaluate((v: HTMLVideoElement) => v.videoWidth > 0 && !v.paused), { timeout: 20_000 })
      .toBe(true);
    // And the side panel folds its copy of the faces away.
    await expect(alice.locator('.tiles-fold')).toHaveAttribute('data-folded', '');
    // The call is measured once it is up.
    await expect(alice.getByLabel(/connection quality|measuring connection/i)).toBeVisible();

    // ── the room takes the picture's colour ────────────────────────────────
    await expect
      .poll(
        () =>
          alice.locator('.stage-wrap').evaluate((el) => {
            const [r, g, b] = getComputedStyle(el).getPropertyValue('--amb-l').match(/\d+/g)?.map(Number) ?? [0, 0, 0];
            return g > r && g > b; // the fake camera is green
          }),
        { timeout: 10_000 },
      )
      .toBe(true);

    // ── their voice lights the frame ───────────────────────────────────────
    await expect
      .poll(
        () =>
          alice
            .locator('.stage--peer')
            .evaluate((el) => parseFloat(getComputedStyle(el).getPropertyValue('--level')) || 0),
        { timeout: 10_000, intervals: [100] },
      )
      .toBeGreaterThan(0.05);

    // ── chat, both ways, with a typing line in between ─────────────────────
    const aliceInput = alice.getByRole('textbox', { name: 'Message' });
    await aliceInput.fill('hi bob, can you see me?');
    await expect(bob.getByText('alice is typing')).toBeVisible({ timeout: 10_000 });
    await aliceInput.press('Enter');
    await expect(bob.getByRole('log', { name: 'Messages' }).getByText('hi bob, can you see me?')).toBeVisible();
    await bob.getByRole('textbox', { name: 'Message' }).fill('loud and clear');
    await bob.getByRole('textbox', { name: 'Message' }).press('Enter');
    await expect(alice.getByRole('log', { name: 'Messages' }).getByText('loud and clear')).toBeVisible();

    // ── a reaction flies from one screen to the other ──────────────────────
    await alice.getByRole('button', { name: /^react$/i }).click();
    await alice.getByRole('button', { name: 'React with 🔥' }).click();
    await expect(alice.getByLabel('alice reacted with 🔥')).toBeAttached();
    await expect(bob.getByLabel('alice reacted with 🔥')).toBeAttached({ timeout: 10_000 });

    // ── mute and camera cross over ─────────────────────────────────────────
    await alice.keyboard.press('Escape');
    await alice.locator('body').click({ position: { x: 5, y: 400 } });
    await alice.keyboard.press('m');
    await expect(bob.getByLabel('alice is muted').first()).toBeVisible();
    await bob.locator('body').click({ position: { x: 5, y: 400 } });
    await bob.keyboard.press('v');
    await expect(alice.getByLabel("bob's camera is off")).toBeVisible();
    await bob.keyboard.press('v');
    await expect(alice.getByLabel("bob's camera is off")).toHaveCount(0);

    // ── your own window can be parked in any corner ────────────────────────
    const self = alice.locator('.selfview');
    await expect(self).toHaveAttribute('data-corner', 'br');
    const selfBox = (await self.boundingBox())!;
    const stageBox = (await alice.locator('.stage--peer').boundingBox())!;
    await alice.mouse.move(selfBox.x + selfBox.width / 2, selfBox.y + selfBox.height / 2);
    await alice.mouse.down();
    await alice.mouse.move(stageBox.x + 120, stageBox.y + 90, { steps: 12 });
    await alice.mouse.up();
    await expect(self).toHaveAttribute('data-corner', 'tl');
    // It remembers.
    expect(await alice.evaluate(() => localStorage.getItem('wt:selfview:corner'))).toBe('tl');

    // ── watching together becomes available once the call is up ────────────
    await alice.getByRole('button', { name: /^more$/i }).click();
    await expect(alice.getByRole('button', { name: /watch a video together/i })).toBeVisible();
    await alice.keyboard.press('Escape');

    // ── leaving ─────────────────────────────────────────────────────────────
    await bob.getByRole('button', { name: /leave session/i }).click();
    await expect(alice.getByText('They left the session')).toBeVisible({ timeout: 10_000 });
    await expect(alice.getByRole('heading', { name: /they left/i })).toBeVisible();

    await alice.context().close();
    await bob.context().close();
  });

  test('a screen share asks first, then plays on the other side', async ({ browser }) => {
    test.slow();
    const alice = await person(browser, 'alice');
    const bob = await person(browser, 'bob');
    await relaySignalling(
      [
        { page: alice, name: 'alice' },
        { page: bob, name: 'bob' },
      ],
      'alice',
    );

    await join(alice);
    await join(bob);
    await expect(connected(alice)).toBeVisible({ timeout: 20_000 });

    const canCapture = await alice.evaluate(() =>
      navigator.mediaDevices
        .getDisplayMedia({ video: true })
        .then((s) => {
          s.getTracks().forEach((t) => t.stop());
          return true;
        })
        .catch(() => false),
    );
    test.skip(!canCapture, 'this Chromium build cannot capture a screen headlessly');

    await alice.getByRole('button', { name: /^share screen$/i }).click();
    await expect(alice.getByText(/waiting for bob to allow your screen/i)).toBeVisible({ timeout: 10_000 });

    const ask = bob.getByRole('dialog', { name: /alice wants to share their screen/i });
    await expect(ask).toBeVisible();
    await ask.getByRole('button', { name: /^allow$/i }).click();

    await expect(alice.getByText(/you’re sharing your screen/i)).toBeVisible({ timeout: 15_000 });
    await expect(bob.getByText(/alice is sharing/i)).toBeVisible({ timeout: 15_000 });
    await expect
      .poll(() => bob.locator('.stage--share > video').evaluate((v: HTMLVideoElement) => v.videoWidth > 0), {
        timeout: 20_000,
      })
      .toBe(true);

    await alice.getByRole('button', { name: /^stop sharing$/i }).click();
    await expect(bob.getByText(/alice is sharing/i)).toHaveCount(0, { timeout: 10_000 });

    await alice.context().close();
    await bob.context().close();
  });
});
