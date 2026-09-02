import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { FullscreenPortal } from './FullscreenPortal';

/**
 * Rendered with react-dom directly rather than a testing library, because the
 * repo has none and the question is a DOM one: WHERE did the children land.
 * A `.ts` file with createElement rather than `.test.tsx`, because vitest's
 * include glob is `src/**\/*.test.ts` and widening it is a separate decision.
 */

beforeAll(() => {
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
});

function defineFullscreen(el: Element | null): void {
  Object.defineProperty(document, 'fullscreenElement', { configurable: true, get: () => el });
}

/** Enter or leave fullscreen the way a browser would report it. */
function setFullscreen(el: Element | null): void {
  defineFullscreen(el);
  act(() => {
    document.dispatchEvent(new Event('fullscreenchange'));
  });
}

describe('FullscreenPortal', () => {
  let mount: HTMLDivElement;
  let stage: HTMLDivElement;
  let root: Root;

  const overlay = () => createElement('span', { id: 'overlay' }, 'toast');
  const inMount = () => mount.querySelector('#overlay');
  const inStage = () => stage.querySelector('#overlay');

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    delete (document as unknown as Record<string, unknown>).fullscreenElement;
    document.body.innerHTML = '';
  });

  function render(): void {
    mount = document.createElement('div');
    stage = document.createElement('div');
    document.body.append(mount, stage);
    root = createRoot(mount);
    act(() => {
      root.render(createElement(FullscreenPortal, null, overlay()));
    });
  }

  it('renders inline when nothing is fullscreen', () => {
    render();

    expect(inMount()).not.toBeNull();
    expect(inStage()).toBeNull();
  });

  it('moves the children into the fullscreen element, and back out on exit', () => {
    render();

    setFullscreen(stage);
    expect(inStage()).not.toBeNull();
    expect(inMount()).toBeNull();

    setFullscreen(null);
    expect(inMount()).not.toBeNull();
    expect(inStage()).toBeNull();
  });

  it('follows a fullscreen element that is already up when it mounts', () => {
    mount = document.createElement('div');
    stage = document.createElement('div');
    document.body.append(mount, stage);
    defineFullscreen(stage);

    root = createRoot(mount);
    act(() => {
      root.render(createElement(FullscreenPortal, null, overlay()));
    });

    expect(inStage()).not.toBeNull();
    expect(inMount()).toBeNull();
  });

  /**
   * The YouTube player fullscreens its own cross-origin iframe. Children of an
   * iframe element are fallback content and never painted, so there is nothing
   * to gain by portaling into it — stay inline rather than vanish into it.
   */
  it('stays inline when the fullscreen element cannot host children', () => {
    render();
    const iframe = document.createElement('iframe');
    document.body.appendChild(iframe);

    setFullscreen(iframe);
    expect(inMount()).not.toBeNull();
    expect(iframe.querySelector('#overlay')).toBeNull();
  });
});
