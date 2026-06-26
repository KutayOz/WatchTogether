import { type MouseEvent as ReactMouseEvent, useState, useCallback, useEffect } from 'react';

// Resizable sidebar width. Persisted in localStorage so the user's preferred
// chat width survives page reloads. Min 280 keeps chat readable; max 480
// stops the screen-share panel from getting squeezed. Default = MIN so
// first-time users see the widest possible screen-share area.
const SIDEBAR_MIN = 280;
const SIDEBAR_MAX = 480;
const SIDEBAR_DEFAULT = SIDEBAR_MIN;

/**
 * Owns the desktop sidebar's resizable + persisted width and the drag
 * interaction. The handle sits on the sidebar's LEFT edge: pulling left grows
 * the sidebar (and shrinks the screen-share panel), pulling right does the
 * inverse. Extracted from SessionRoom — pure UI state, no signalling/WebRTC.
 */
export function useResizableSidebar() {
  const [sidebarWidth, setSidebarWidth] = useState<number>(() => {
    if (typeof window === 'undefined') return SIDEBAR_DEFAULT;
    const saved = window.localStorage.getItem('wt:sidebar:width');
    const parsed = saved ? parseInt(saved, 10) : NaN;
    if (Number.isNaN(parsed)) return SIDEBAR_DEFAULT;
    return Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, parsed));
  });
  const [isResizingSidebar, setIsResizingSidebar] = useState(false);

  const handleSidebarResizeStart = useCallback((e: ReactMouseEvent) => {
    e.preventDefault();
    setIsResizingSidebar(true);
    const startX = e.clientX;
    const startWidth = sidebarWidth;

    const onMove = (ev: MouseEvent) => {
      // Drag handle is on the LEFT edge of the sidebar — pulling LEFT
      // grows the sidebar, pulling RIGHT shrinks it.
      const delta = startX - ev.clientX;
      const next = Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, startWidth + delta));
      setSidebarWidth(next);
    };
    const onUp = () => {
      setIsResizingSidebar(false);
      window.removeEventListener('mousemove', onMove);
      window.removeEventListener('mouseup', onUp);
    };
    window.addEventListener('mousemove', onMove);
    window.addEventListener('mouseup', onUp);
  }, [sidebarWidth]);

  // Persist width across reloads. Debounced effectively by React's render
  // batching, so dragging doesn't slam localStorage on every pixel.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.localStorage.setItem('wt:sidebar:width', String(sidebarWidth));
  }, [sidebarWidth]);

  return { sidebarWidth, isResizingSidebar, handleSidebarResizeStart, SIDEBAR_MIN, SIDEBAR_MAX };
}
