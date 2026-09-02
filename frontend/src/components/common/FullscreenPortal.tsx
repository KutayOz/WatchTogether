import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { useFullscreenElement } from '../../hooks/useFullscreenElement';

/**
 * Keep an overlay visible while some element is fullscreen.
 *
 * Outside fullscreen this renders its children exactly where they are — same
 * DOM, same parents, nothing to regress. While an element is fullscreen it
 * portals them into that element instead, which is the only place the browser
 * will paint them: the fullscreen element sits in the top layer, and the top
 * layer is above every other stacking context on the page regardless of
 * z-index. See useFullscreenElement for the failure this answers.
 *
 * Positioning still works inside the portal. The UA stylesheet gives the
 * fullscreen element `position: fixed; inset: 0; transform: none`, so a
 * `position: fixed` toast keeps the viewport as its containing block and a
 * `position: absolute; inset: 0` overlay fills the fullscreen element. The
 * z-indexes the overlays already carry (65 to 9500) are compared against the
 * container's own children, none of which go above 4.
 *
 * Toggling fullscreen moves the children between an inline parent and the
 * portal, which React treats as an unmount and a remount. For everything this
 * wraps that is the right trade: a toast restarts its dismiss timer, a modal
 * that was open stays open because `isOpen` is a prop, and nothing here holds
 * state worth carrying across the transition.
 */
export function FullscreenPortal({ children }: { children: ReactNode }) {
  const target = useFullscreenElement();
  const host = target && canHostOverlays(target) ? target : null;
  return host ? createPortal(children, host) : <>{children}</>;
}

/**
 * Not every fullscreen element can hold children we render.
 *
 * The YouTube player fullscreens its own cross-origin iframe, and a bare
 * `<video>` with native controls would fullscreen itself. Children appended
 * to either are never painted — an iframe's are fallback content, a video's
 * are ignored — so the inline render is the honest fallback there, even though
 * it is just as invisible as before. Nothing in this app goes fullscreen that
 * way today; the guard is for the day something does.
 */
function canHostOverlays(el: Element): boolean {
  return !(el instanceof HTMLIFrameElement) && !(el instanceof HTMLVideoElement);
}
