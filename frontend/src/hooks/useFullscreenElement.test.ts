import { afterEach, describe, expect, it, vi } from 'vitest';
import { getFullscreenElement, subscribeFullscreen } from './useFullscreenElement';

/**
 * happy-dom has no Fullscreen API, which is convenient: the property is
 * whatever the test defines it to be, and there is no real top layer to fight.
 */
type FullscreenKey = 'fullscreenElement' | 'webkitFullscreenElement';

function defineFullscreen(key: FullscreenKey, el: Element | null): void {
  Object.defineProperty(document, key, { configurable: true, get: () => el });
}

function clearFullscreen(): void {
  for (const key of ['fullscreenElement', 'webkitFullscreenElement'] as const) {
    delete (document as unknown as Record<string, unknown>)[key];
  }
}

describe('getFullscreenElement', () => {
  afterEach(() => {
    clearFullscreen();
    document.body.innerHTML = '';
  });

  it('is null when nothing is fullscreen', () => {
    expect(getFullscreenElement()).toBeNull();
  });

  it('is the fullscreen element', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    defineFullscreen('fullscreenElement', el);

    expect(getFullscreenElement()).toBe(el);
  });

  it('falls back to the WebKit-prefixed property', () => {
    const el = document.createElement('div');
    document.body.appendChild(el);
    defineFullscreen('webkitFullscreenElement', el);

    expect(getFullscreenElement()).toBe(el);
  });

  /**
   * Stopping a share unmounts the fullscreen container; the browser exits
   * fullscreen because of that, but `fullscreenchange` lands after the node is
   * already gone. A detached host paints nothing, so it must read as no host.
   */
  it('is null for a fullscreen element that has left the DOM', () => {
    const el = document.createElement('div');
    defineFullscreen('fullscreenElement', el);

    expect(el.isConnected).toBe(false);
    expect(getFullscreenElement()).toBeNull();
  });
});

describe('subscribeFullscreen', () => {
  it('fires on both spellings of the event, and not after unsubscribing', () => {
    const onChange = vi.fn();
    const unsubscribe = subscribeFullscreen(onChange);

    document.dispatchEvent(new Event('fullscreenchange'));
    document.dispatchEvent(new Event('webkitfullscreenchange'));
    expect(onChange).toHaveBeenCalledTimes(2);

    unsubscribe();
    document.dispatchEvent(new Event('fullscreenchange'));
    expect(onChange).toHaveBeenCalledTimes(2);
  });
});
