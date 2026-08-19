import { useEffect } from 'react';
import { SectionTitle, BackButton } from '../manga';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * Cheat sheet modal — opens on `?`, closes on Esc or click outside.
 * Sketchbook page style so it fits the rest of the manga UI.
 *
 * The shortcuts shown here are duplicated from useKeyboardShortcuts.ts
 * (single source of truth would mean exporting metadata, but the list is
 * five entries and changes rarely — keeping it inline reads better here).
 */

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['M'], label: 'mute / unmute' },
  { keys: ['V'], label: 'camera on / off' },
  { keys: ['S'], label: 'share screen' },
  { keys: ['C'], label: 'show / hide sidebar' },
  { keys: ['D'], label: 'debug report (copy for a bug report)' },
  { keys: ['Esc'], label: 'exit fullscreen' },
  { keys: ['?'], label: 'this cheat sheet' },
];

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  useEffect(() => {
    if (!isOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="kbd-shortcuts-title"
      onClick={onClose}
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26, 20, 23, 0.6)',
        backdropFilter: 'blur(2px)',
        display: 'grid',
        placeItems: 'center',
        zIndex: 9000,
        padding: 24,
      }}
    >
      <div
        // Stop click-outside from propagating to the backdrop dismiss.
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--cream)',
          border: '4px solid var(--ink)',
          boxShadow: '8px 8px 0 var(--ink)',
          padding: '24px 28px',
          maxWidth: 460,
          width: '100%',
          transform: 'rotate(-0.6deg)',
        }}
      >
        <div id="kbd-shortcuts-title" style={{ marginBottom: 14 }}>
          <SectionTitle size={32} underline="pink">
            CHEAT SHEET
          </SectionTitle>
        </div>

        <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
          {SHORTCUTS.map((s) => (
            <li
              key={s.label}
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 14,
                fontFamily: 'var(--font-body)',
                fontSize: 16,
                color: 'var(--ink)',
              }}
            >
              <span style={{ display: 'inline-flex', gap: 4, flexShrink: 0 }}>
                {s.keys.map((k) => (
                  <kbd
                    key={k}
                    style={{
                      display: 'inline-block',
                      minWidth: 32,
                      padding: '4px 8px',
                      background: 'var(--cream-deep)',
                      border: '2.5px solid var(--ink)',
                      boxShadow: '2px 2px 0 var(--ink)',
                      fontFamily: 'var(--font-sfx)',
                      fontSize: 14,
                      letterSpacing: 1,
                      textAlign: 'center',
                      transform: 'rotate(-1deg)',
                    }}
                  >
                    {k}
                  </kbd>
                ))}
              </span>
              <span className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.75)' }}>
                {s.label}
              </span>
            </li>
          ))}
        </ul>

        <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end' }}>
          <BackButton onClick={onClose}>got it</BackButton>
        </div>
      </div>
    </div>
  );
}
