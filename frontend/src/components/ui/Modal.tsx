import { useEffect, useId, useRef, type ReactNode } from 'react';
import { AnimatePresence, m, useDragControls, type PanInfo } from 'motion/react';
import { IconButton } from './Button';
import { CloseIcon } from './icons';
import { spring } from './motion';
import { PHONE, useMediaQuery } from './useMediaQuery';

export interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  footer?: ReactNode;
  /** Split the footer: first child left, the rest right. */
  footerSplit?: boolean;
  /** Max width in px on larger screens. Phones always get a full-width sheet. */
  width?: number;
  /**
   * False for decisions that must be answered: no backdrop click, no Escape,
   * no swipe-down. The close button stays unless `hideClose` is set too.
   */
  dismissible?: boolean;
  hideClose?: boolean;
  /** Extra class on the dialog surface. */
  className?: string;
  /** For dialogs whose title is not the right accessible name. */
  ariaLabel?: string;
}

let openCount = 0;

/**
 * The dialog.
 *
 * Rendered in place, not portalled to <body>: in a call, the element that goes
 * fullscreen is the only thing the browser paints, and FullscreenPortal moves
 * the room's overlays into it. A modal that portalled itself out to <body>
 * would escape that and vanish the moment someone went fullscreen.
 *
 * On a phone it becomes a bottom sheet, and the grab handle can drag it away.
 * Focus is held inside while it is open and handed back to whatever opened it.
 */
export function Modal({
  isOpen,
  onClose,
  title,
  description,
  children,
  footer,
  footerSplit = false,
  width = 520,
  dismissible = true,
  hideClose = false,
  className,
  ariaLabel,
}: ModalProps) {
  const titleId = useId();
  const descId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const isSheet = useMediaQuery(PHONE);
  const drag = useDragControls();

  // Latest onClose without re-running the key effect every render.
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    onCloseRef.current = onClose;
  });

  useEffect(() => {
    if (!isOpen) return;
    const opener = document.activeElement as HTMLElement | null;

    openCount += 1;
    const root = document.documentElement;
    const previousOverflow = root.style.overflow;
    root.style.overflow = 'hidden';

    // Focus the first thing that asked for it, else the dialog itself — after
    // the enter animation has put it on screen.
    const focusTimer = window.setTimeout(() => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      const preferred = dialog.querySelector<HTMLElement>('[data-autofocus]');
      (preferred ?? dialog).focus({ preventScroll: true });
    }, 30);

    const onKey = (e: KeyboardEvent) => {
      const dialog = dialogRef.current;
      if (!dialog) return;
      if (e.key === 'Escape' && dismissible) {
        e.preventDefault();
        e.stopPropagation();
        onCloseRef.current();
        return;
      }
      if (e.key !== 'Tab') return;
      const focusable = Array.from(
        dialog.querySelectorAll<HTMLElement>(
          'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
        ),
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);
      if (focusable.length === 0) {
        e.preventDefault();
        dialog.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (e.shiftKey && (document.activeElement === first || document.activeElement === dialog)) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };
    window.addEventListener('keydown', onKey, true);

    return () => {
      window.clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKey, true);
      openCount -= 1;
      if (openCount === 0) root.style.overflow = previousOverflow;
      // Hand focus back, if what had it still exists.
      if (opener && document.contains(opener)) opener.focus({ preventScroll: true });
    };
  }, [isOpen, dismissible]);

  const onDragEnd = (_: unknown, info: PanInfo) => {
    if (info.offset.y > 110 || info.velocity.y > 600) onClose();
  };

  return (
    <AnimatePresence>
      {isOpen && (
        <div className="modal-root" key="modal">
          <m.div
            className="modal-backdrop"
            aria-hidden="true"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.2 } }}
            transition={{ duration: 0.28 }}
            onClick={dismissible ? onClose : undefined}
          />
          <m.div
            ref={dialogRef}
            role="dialog"
            aria-modal="true"
            aria-labelledby={ariaLabel ? undefined : titleId}
            aria-label={ariaLabel}
            aria-describedby={description ? descId : undefined}
            tabIndex={-1}
            className={['modal', className].filter(Boolean).join(' ')}
            style={{ ['--modal-w' as string]: `${width}px` }}
            initial={isSheet ? { y: '100%' } : { opacity: 0, scale: 0.94, y: 18, filter: 'blur(6px)' }}
            animate={isSheet ? { y: 0 } : { opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
            exit={
              isSheet
                ? { y: '100%', transition: { duration: 0.26, ease: [0.4, 0, 1, 1] } }
                : { opacity: 0, scale: 0.97, y: 8, filter: 'blur(4px)', transition: { duration: 0.18 } }
            }
            transition={spring.soft}
            drag={isSheet && dismissible ? 'y' : false}
            dragListener={false}
            dragControls={drag}
            dragConstraints={{ top: 0, bottom: 0 }}
            dragElastic={{ top: 0, bottom: 0.7 }}
            onDragEnd={onDragEnd}
          >
            <div
              className="modal__grab"
              aria-hidden="true"
              onPointerDown={(e) => {
                if (isSheet && dismissible) drag.start(e);
              }}
              style={{ touchAction: 'none' }}
            />
            {!hideClose && (
              <IconButton label="Close dialog" size="sm" bare className="modal__close" onClick={onClose} tip={false}>
                <CloseIcon size={18} />
              </IconButton>
            )}
            <header className="modal__header">
              <h2 className="modal__title" id={titleId}>
                {title}
              </h2>
              {description && (
                <p className="modal__desc" id={descId}>
                  {description}
                </p>
              )}
            </header>
            {children != null && <div className="modal__body">{children}</div>}
            {footer && (
              <footer className={['modal__footer', footerSplit && 'modal__footer--split'].filter(Boolean).join(' ')}>
                {footer}
              </footer>
            )}
          </m.div>
        </div>
      )}
    </AnimatePresence>
  );
}
