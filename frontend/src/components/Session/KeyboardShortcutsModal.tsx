import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';

interface KeyboardShortcutsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

/**
 * The cheat sheet — opens on `?`, closes on Esc or a click outside.
 *
 * The shortcuts listed here are duplicated from useKeyboardShortcuts.ts
 * (single source of truth would mean exporting metadata, but the list is
 * seven entries and changes rarely — keeping it inline reads better here).
 */

const SHORTCUTS: Array<{ keys: string[]; label: string }> = [
  { keys: ['M'], label: 'Mute or unmute' },
  { keys: ['V'], label: 'Camera on or off' },
  { keys: ['S'], label: 'Share your screen' },
  { keys: ['C'], label: 'Show or hide the chat panel' },
  { keys: ['D'], label: 'Debug report, to paste into a bug report' },
  { keys: ['Esc'], label: 'Exit fullscreen' },
  { keys: ['?'], label: 'This list' },
];

export function KeyboardShortcutsModal({ isOpen, onClose }: KeyboardShortcutsModalProps) {
  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Keyboard shortcuts"
      description="They work anywhere in the call except while you’re typing."
      width={460}
      footer={
        <Button variant="secondary" onClick={onClose} data-autofocus="">
          Got it
        </Button>
      }
    >
      <ul className="keys">
        {SHORTCUTS.map((s) => (
          <li key={s.label}>
            <span>
              {s.keys.map((k) => (
                <kbd key={k} className="key">
                  {k}
                </kbd>
              ))}
            </span>
            <span>{s.label}</span>
          </li>
        ))}
      </ul>
    </Modal>
  );
}
