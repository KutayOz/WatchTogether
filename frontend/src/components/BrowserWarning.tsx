import { m } from 'motion/react';
import { Modal } from './ui/Modal';
import { Button } from './ui/Button';
import { AlertIcon, GlobeIcon } from './ui/icons';
import { ease } from './ui/motion';

interface BrowserWarningProps {
  type: 'blocking' | 'dismissible';
  message: string;
  onDismiss?: () => void;
}

const BROWSERS = [
  { href: 'https://www.google.com/chrome/', label: 'Chrome' },
  { href: 'https://www.mozilla.org/firefox/', label: 'Firefox' },
  { href: 'https://www.microsoft.com/edge', label: 'Edge' },
];

/**
 * What an unsupported browser sees first.
 *
 * Blocking covers the whole app — there is no point offering a call that
 * cannot connect. Dismissible is an ordinary dialog: a heads-up, then out of
 * the way for good (the dismissal is remembered per browser).
 */
export function BrowserWarning({ type, message, onDismiss }: BrowserWarningProps) {
  if (type === 'blocking') {
    return (
      <div className="browser-block" role="alertdialog" aria-modal="true" aria-labelledby="browser-block-title">
        <m.div
          className="sheet browser-block__sheet"
          initial={{ opacity: 0, y: 24, filter: 'blur(8px)' }}
          animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
          transition={{ duration: 0.7, ease: ease.out }}
        >
          <span className="status-card__icon" aria-hidden="true">
            <AlertIcon size={28} />
          </span>
          <h1 id="browser-block-title" className="browser-block__title">
            This browser can’t run a call
          </h1>
          <p className="browser-block__msg">{message}</p>
          <p className="muted">Open WatchTogether in one of these instead:</p>
          <div className="browser-block__links">
            {BROWSERS.map((b) => (
              <a
                key={b.label}
                href={b.href}
                target="_blank"
                rel="noopener noreferrer"
                className="btn btn--secondary"
                data-light=""
              >
                <GlobeIcon size={18} />
                <span>{b.label}</span>
              </a>
            ))}
          </div>
        </m.div>
      </div>
    );
  }

  return (
    <Modal
      isOpen
      onClose={() => onDismiss?.()}
      title="Heads up about this browser"
      description={message}
      width={460}
      footer={
        <Button variant="primary" onClick={onDismiss} data-autofocus="">
          Got it
        </Button>
      }
    >
      <p className="muted">For the smoothest call, use Chrome, Firefox or Edge.</p>
    </Modal>
  );
}
