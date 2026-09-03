import { useSyncExternalStore } from 'react';

/**
 * Which element, if any, the document is currently showing fullscreen.
 *
 * The reason this exists is the browser's top layer. `requestFullscreen()`
 * promotes one element above everything else on the page, and nothing outside
 * that element's subtree is painted or clickable while it is up — no z-index,
 * no `position: fixed` gets past it. Every overlay this app renders at the
 * room level (toasts, the share request, the modals, the connection overlay)
 * lives outside `ScreenShareView`'s container, which is exactly the element
 * that goes fullscreen. So in fullscreen they all kept firing and none of them
 * could be seen: a "reconnecting…" toast, an incoming share request, or the
 * `D` debug modal that also disables every keyboard shortcut while it is open.
 *
 * `FullscreenPortal` uses this to re-parent those overlays INTO the fullscreen
 * element for as long as one exists. A hook rather than a ref read because the
 * answer changes at runtime and the consumers have to re-render when it does.
 */

/** Safari spells the property with a prefix. */
type PrefixedDocument = Document & { webkitFullscreenElement?: Element | null };

/**
 * The fullscreen element, or null.
 *
 * Null also for a fullscreen element that has left the DOM. Stopping a share
 * unmounts the container that was fullscreen, and the browser exits fullscreen
 * as a consequence — but the `fullscreenchange` that announces it arrives a
 * beat after the node is detached. Portaling into a detached node renders
 * nothing, and rendering nothing is not what an overlay is for.
 */
export function getFullscreenElement(doc: Document = document): Element | null {
  const d = doc as PrefixedDocument;
  const el = d.fullscreenElement ?? d.webkitFullscreenElement ?? null;
  return el && el.isConnected ? el : null;
}

/** Both spellings of the event, for the same reason as the property. */
export function subscribeFullscreen(onChange: () => void, doc: Document = document): () => void {
  doc.addEventListener('fullscreenchange', onChange);
  doc.addEventListener('webkitfullscreenchange', onChange);
  return () => {
    doc.removeEventListener('fullscreenchange', onChange);
    doc.removeEventListener('webkitfullscreenchange', onChange);
  };
}

// Module-level so useSyncExternalStore sees one stable subscribe function
// rather than resubscribing on every render. The hook passes only the
// callback; the document parameter keeps its default.
const subscribe = (onChange: () => void) => subscribeFullscreen(onChange);
const getSnapshot = () => getFullscreenElement();
// No fullscreen on the server, and the SPA has no server render anyway.
const getServerSnapshot = () => null;

export function useFullscreenElement(): Element | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}
