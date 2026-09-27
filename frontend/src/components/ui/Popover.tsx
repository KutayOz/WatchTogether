import type { CSSProperties, ReactNode } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { spring } from './motion';

interface PopoverProps {
  open: boolean;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  style?: CSSProperties;
  /** Accessible name when there is no visible title. */
  label?: string;
  id?: string;
}

/**
 * A panel that grows out of the control that opened it. Positioning is the
 * wrapper's job (it is `position: relative` around trigger + popover); this
 * only handles appearance, presence and semantics.
 */
export function Popover({ open, title, children, className, style, label, id }: PopoverProps) {
  return (
    <AnimatePresence>
      {open && (
        <m.div
          id={id}
          role="dialog"
          aria-label={label ?? (typeof title === 'string' ? title : undefined)}
          className={['popover', className].filter(Boolean).join(' ')}
          style={style}
          initial={{ opacity: 0, scale: 0.9, y: 10, filter: 'blur(4px)' }}
          animate={{ opacity: 1, scale: 1, y: 0, filter: 'blur(0px)' }}
          exit={{ opacity: 0, scale: 0.94, y: 6, filter: 'blur(2px)', transition: { duration: 0.14 } }}
          transition={spring.snappy}
        >
          {title && <div className="popover__title">{title}</div>}
          {children}
        </m.div>
      )}
    </AnimatePresence>
  );
}
