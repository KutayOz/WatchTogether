import { useEffect } from 'react';

interface ShortcutHandlers {
  onMuteToggle?: () => void;
  onCameraToggle?: () => void;
  onScreenShareToggle?: () => void;
  onSidebarToggle?: () => void;
  onCheatSheet?: () => void;
  /** Whole hook can be turned off (e.g. while a modal is open and owns input). */
  enabled?: boolean;
}

/**
 * In-session keyboard shortcuts, sector-standard letter map:
 *
 *   M  → mute toggle              (Zoom / Meet / Discord)
 *   V  → camera toggle            (Zoom / Meet)
 *   S  → screen share toggle      (custom, intuitive)
 *   C  → chat / sidebar toggle    (Discord / Slack)
 *   ?  → cheat sheet modal        (Linear / Notion / GitHub)
 *
 * Critical guard: shortcuts MUST NOT fire while the user is typing in an
 * input. ChatPanel + any future text input is full of `m`, `v`, etc. The
 * isEditableTarget() check below ignores key events whose target is an
 * <input>, <textarea>, or [contenteditable] element.
 *
 * We deliberately skip:
 *   - Cmd/Ctrl + key combos: collide with browser shortcuts.
 *   - Space (push-to-talk): needs hold-key state machine and explicit
 *     opt-in; planned for a later iteration.
 *   - Escape: SessionRoom-level (leave confirm), handled separately.
 */
export function useKeyboardShortcuts(handlers: ShortcutHandlers): void {
  const { enabled = true } = handlers;

  useEffect(() => {
    if (!enabled) return;

    const onKey = (e: KeyboardEvent) => {
      if (isEditableTarget(e.target)) return;
      // Don't steal modifier combos (Cmd+R reload, Cmd+K commandbar, etc.)
      if (e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key.toLowerCase()) {
        case 'm':
          if (handlers.onMuteToggle) {
            e.preventDefault();
            handlers.onMuteToggle();
          }
          break;
        case 'v':
          if (handlers.onCameraToggle) {
            e.preventDefault();
            handlers.onCameraToggle();
          }
          break;
        case 's':
          if (handlers.onScreenShareToggle) {
            e.preventDefault();
            handlers.onScreenShareToggle();
          }
          break;
        case 'c':
          if (handlers.onSidebarToggle) {
            e.preventDefault();
            handlers.onSidebarToggle();
          }
          break;
        case '?':
        case '/':
          // Both '?' (shift+/) and bare '/' open the cheat sheet —
          // matches Linear/Notion behavior where some keyboards/locales
          // make the shifted form awkward.
          if (handlers.onCheatSheet && (e.key === '?' || e.shiftKey)) {
            e.preventDefault();
            handlers.onCheatSheet();
          }
          break;
      }
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, handlers]);
}

function isEditableTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  if (target.isContentEditable) return true;
  return false;
}
