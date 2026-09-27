import { test, expect, type Page } from '@playwright/test';
import { disableAnimations, enterSession, expectPathname, mockLobby, type SignallingMock } from './helpers';

/**
 * The call screen, end to end in one browser.
 *
 * The camera and mic are Chromium's fake devices (see playwright.config.ts),
 * so the device check and the room run on real MediaStreams. The signalling
 * socket is played by the test (mockSignalling): it answers the join, echoes
 * chat, and pushes whatever the room would push — the other person arriving,
 * writing, muting, asking to share, leaving.
 *
 * What this cannot cover is media actually flowing between two peers: there
 * is no second browser answering the offer. The Durable Object's side of the
 * protocol is covered in worker/src/do/SessionRoom.test.ts.
 */

async function joinRoom(page: Page, opts: { micOff?: boolean } = {}) {
  const { sessionId, signalling } = await enterSession(page);
  await page.goto(`/session/${sessionId}`);

  await expect(page.getByRole('heading', { name: /check your picture and sound/i })).toBeVisible();
  const join = page.getByRole('button', { name: /^join/i });
  await expect(join).toBeEnabled({ timeout: 15_000 });

  if (opts.micOff) {
    await page.getByRole('switch', { name: 'Microphone' }).click();
    await expect(page.getByRole('button', { name: /^join muted$/i })).toBeVisible();
  }

  await page.getByRole('button', { name: /^join/i }).click();
  await expect(page.getByText(/waiting for someone to join/i)).toBeVisible({ timeout: 15_000 });
  return { sessionId, signalling };
}

function peerArrives(signalling: SignallingMock, name = 'bob') {
  signalling.push({ t: 'PeerJoined', d: { name } });
}

test.describe('Device check', () => {
  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
  });

  test('shows a live preview, the mic trace, and both devices', async ({ page }) => {
    const { sessionId } = await enterSession(page);
    await page.goto(`/session/${sessionId}`);

    // The fake camera is actually playing into the preview.
    const preview = page.locator('.preview video');
    await expect
      .poll(() => preview.evaluate((v: HTMLVideoElement) => v.readyState >= 2 && v.videoWidth > 0), { timeout: 15_000 })
      .toBe(true);

    await expect(page.getByRole('meter', { name: /microphone input level/i })).toBeVisible();
    await expect(page.getByRole('switch', { name: 'Microphone' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByRole('switch', { name: 'Camera' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Camera', { exact: true }).and(page.locator('select'))).toBeEnabled();
    await expect(page.getByLabel('Microphone', { exact: true }).and(page.locator('select'))).toBeEnabled();
  });

  test('the join button says how you will arrive', async ({ page }) => {
    const { sessionId } = await enterSession(page);
    await page.goto(`/session/${sessionId}`);
    await expect(page.getByRole('button', { name: /^join$/i })).toBeEnabled({ timeout: 15_000 });

    await page.getByRole('switch', { name: 'Camera' }).click();
    await expect(page.getByRole('switch', { name: 'Camera' })).toHaveAttribute('aria-checked', 'false');
    await expect(page.getByRole('button', { name: /^join with camera off$/i })).toBeVisible();
    await expect(page.getByText('Camera off', { exact: true })).toBeVisible();

    await page.getByRole('switch', { name: 'Microphone' }).click();
    await expect(page.getByRole('button', { name: /^join muted, camera off$/i })).toBeVisible();
  });

  test('back to lobby leaves without joining', async ({ page }) => {
    const { sessionId, signalling } = await enterSession(page);
    await mockLobby(page);
    await page.goto(`/session/${sessionId}`);

    await page.getByRole('button', { name: /back to lobby/i }).click();

    await expectPathname(page, '/');
    expect(signalling.sent).toHaveLength(0);
  });

  test('explains blocked camera access and offers a retry', async ({ page }) => {
    const { sessionId } = await enterSession(page);
    await page.addInitScript(() => {
      navigator.mediaDevices.getUserMedia = () =>
        Promise.reject(new DOMException('Permission denied', 'NotAllowedError'));
    });
    await page.goto(`/session/${sessionId}`);

    await expect(page.getByRole('heading', { name: /we need your camera and mic/i })).toBeVisible();
    await expect(page.getByText(/access was blocked/i)).toBeVisible();
    await expect(page.getByRole('button', { name: /try again/i })).toBeVisible();
  });
});

test.describe('The room', () => {
  test.use({ permissions: ['camera', 'microphone', 'clipboard-read', 'clipboard-write'] });

  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
  });

  test('joins, then offers an invite link while waiting', async ({ page }) => {
    await joinRoom(page);

    await page.getByRole('button', { name: /invite someone/i }).click();

    await expect(page.getByText(/session-invite-sess-abc123/)).toBeVisible();
    await expect(page.getByText(/expires in 1[45]:\d\d/i)).toBeVisible();

    await page.getByRole('button', { name: /copy link/i }).click();
    await expect(page.getByRole('button', { name: /^copied$/i })).toBeVisible();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toContain('/join/session-invite-sess-abc123');
  });

  test('your own chat message appears from the room’s echo', async ({ page }) => {
    const { signalling } = await joinRoom(page);

    const input = page.getByRole('textbox', { name: 'Message' });
    await input.fill('hello from the test');
    await input.press('Enter');

    const sent = await signalling.waitForSent('chat');
    expect(sent.d.m).toBe('hello from the test');
    const log = page.getByRole('log', { name: 'Messages' });
    await expect(log.getByText('hello from the test')).toBeVisible();
    await expect(log.getByText('You', { exact: true })).toBeVisible();
    await expect(input).toHaveValue('');
  });

  test('the other person arriving changes the whole room', async ({ page }) => {
    const { signalling } = await joinRoom(page);

    peerArrives(signalling);

    await expect(page.getByText('With bob')).toBeVisible();
    await expect(page.getByRole('status').filter({ hasText: /bob joined the session/i })).toBeVisible();
    // We are the offerer, so we start negotiating and tell them our state.
    await signalling.waitForSent('offer');
    const media = await signalling.waitForSent('media');
    expect(media.d).toMatchObject({ isMuted: false, isCameraOn: true });
    await expect(page.getByText(/bob is here/i)).toBeVisible();
  });

  test('their messages arrive in their colour, and count while chat is hidden', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    peerArrives(signalling);
    await expect(page.getByText('With bob')).toBeVisible();

    signalling.push({
      t: 'ReceiveChatMessage',
      d: { sender: 'bob', message: 'can you hear me?', timestamp: new Date().toISOString() },
    });
    const log = page.getByRole('log', { name: 'Messages' });
    await expect(log.getByText('can you hear me?')).toBeVisible();
    await expect(log.locator('.msg').last()).not.toHaveAttribute('data-own', '');

    // Put chat away, get two more: the dock button counts them.
    await page.getByRole('button', { name: /hide chat/i }).click();
    for (const text of ['one', 'two']) {
      signalling.push({ t: 'ReceiveChatMessage', d: { sender: 'bob', message: text, timestamp: new Date().toISOString() } });
    }
    await expect(page.getByLabel('2 unread messages')).toBeVisible();

    await page.getByRole('button', { name: /show chat/i }).click();
    await expect(page.getByLabel(/unread message/)).toHaveCount(0);
  });

  test('their mute and camera state show on their tile', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    peerArrives(signalling);
    signalling.push({
      t: 'PeerMediaStateChanged',
      d: { name: 'bob', state: { isMuted: true, isCameraOn: false, isScreenSharing: false } },
    });

    await expect(page.getByLabel('bob is muted')).toBeVisible();
  });

  test('mute and camera: buttons and keyboard, and the other side is told', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    peerArrives(signalling);
    await signalling.waitForSent('media');

    await page.getByRole('button', { name: /^mute$/i }).click();
    await expect(page.getByRole('button', { name: /^unmute$/i })).toBeVisible();
    await expect.poll(() => signalling.sent.filter((f) => f.t === 'media').at(-1)?.d.isMuted).toBe(true);

    // M toggles it back — but not while typing in chat.
    await page.getByRole('textbox', { name: 'Message' }).fill('m');
    await expect(page.getByRole('button', { name: /^unmute$/i })).toBeVisible();
    await page.getByRole('textbox', { name: 'Message' }).blur();
    await page.keyboard.press('m');
    await expect(page.getByRole('button', { name: /^mute$/i })).toBeVisible();

    await page.keyboard.press('v');
    await expect(page.getByRole('button', { name: /turn camera on/i })).toBeVisible();
    await expect.poll(() => signalling.sent.filter((f) => f.t === 'media').at(-1)?.d.isCameraOn).toBe(false);
  });

  test('a share request from them waits for an answer and sends it', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    peerArrives(signalling);

    signalling.push({ t: 'ScreenShareRequested', d: { name: 'bob' } });
    const dialog = page.getByRole('dialog', { name: /bob wants to share their screen/i });
    await expect(dialog).toBeVisible();

    // A decision: Escape does not dismiss it.
    await page.keyboard.press('Escape');
    await expect(dialog).toBeVisible();

    await dialog.getByRole('button', { name: /^allow$/i }).click();
    const answer = await signalling.waitForSent('ss:res');
    expect(answer.d.approved).toBe(true);
    await expect(page.getByText(/bob is sharing/i)).toBeVisible();

    signalling.push({ t: 'ScreenShareStopped', d: { name: 'bob' } });
    await expect(page.getByText(/bob is sharing/i)).toHaveCount(0);
  });

  test('shortcuts sheet, debug report, and the more menu', async ({ page }) => {
    await joinRoom(page);

    await page.keyboard.press('Shift+Slash');
    const sheet = page.getByRole('dialog', { name: /keyboard shortcuts/i });
    await expect(sheet).toBeVisible();
    await expect(sheet.getByText('Mute or unmute')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(sheet).toHaveCount(0);

    await page.keyboard.press('d');
    const report = page.getByRole('dialog', { name: /debug report/i });
    await expect(report).toBeVisible();
    await expect(report.getByLabel('Debug report text')).not.toHaveValue('');
    await report.getByRole('button', { name: /^close$/i }).click();
    await expect(report).toHaveCount(0);

    await page.getByRole('button', { name: /^more$/i }).click();
    await expect(page.getByRole('button', { name: /keyboard shortcuts/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /debug report/i })).toBeVisible();
    // Watch together needs a connected call; there is none here.
    await expect(page.getByRole('button', { name: /watch a video together/i })).toHaveCount(0);
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: /keyboard shortcuts/i })).toHaveCount(0);
  });

  test('when they leave, the room says so and the seat empties', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    peerArrives(signalling);
    await expect(page.getByText('With bob')).toBeVisible();

    signalling.push({ t: 'PeerLeft', d: { name: 'bob' } });

    await expect(page.getByText('They left the session')).toBeVisible();
    await expect(page.getByRole('heading', { name: /they left/i })).toBeVisible();
  });

  test('leaving tells the room and returns to the lobby', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    await mockLobby(page);

    await page.getByRole('button', { name: /leave session/i }).click();

    await expectPathname(page, '/');
    await signalling.waitForSent('leave');
  });

  test('joining muted arrives muted', async ({ page }) => {
    const { signalling } = await joinRoom(page, { micOff: true });
    await expect(page.getByRole('button', { name: /^unmute$/i })).toBeVisible();

    peerArrives(signalling);
    await expect.poll(() => signalling.sent.filter((f) => f.t === 'media').at(-1)?.d.isMuted).toBe(true);
  });
});

test.describe('The room on a phone', () => {
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });

  test.beforeEach(async ({ page }) => {
    await disableAnimations(page);
  });

  test('chat is a sheet that opens from the dock and closes again', async ({ page }) => {
    const { signalling } = await joinRoom(page);
    const input = page.getByRole('textbox', { name: 'Message' });

    // Closed by default so the picture gets the screen — and inert, so its
    // input is not reachable behind the stage.
    await expect(input).not.toBeInViewport();

    await page.getByRole('button', { name: /show chat/i }).click();
    await expect(input).toBeInViewport();
    await input.fill('from my phone');
    await input.press('Enter');
    await signalling.waitForSent('chat');
    await expect(page.getByRole('log', { name: 'Messages' }).getByText('from my phone')).toBeVisible();

    await page.getByRole('button', { name: /close panel/i }).click();
    await expect(input).not.toBeInViewport();
  });

  test('the dock fits the screen and keeps the controls that matter', async ({ page }) => {
    await joinRoom(page);
    const dock = page.getByRole('toolbar', { name: 'Call controls' });
    const box = await dock.boundingBox();
    expect(box).not.toBeNull();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(390);

    await expect(dock.getByRole('button', { name: /^mute$/i })).toBeVisible();
    await expect(dock.getByRole('button', { name: /turn camera off/i })).toBeVisible();
    await expect(dock.getByRole('button', { name: /leave session/i })).toBeVisible();
    // Volume and quality move into "more" here.
    await expect(dock.getByRole('button', { name: /^volume$/i })).toBeHidden();
    await dock.getByRole('button', { name: /^more$/i }).click();
    await expect(page.getByRole('button', { name: /stream quality/i })).toBeVisible();
  });
});
