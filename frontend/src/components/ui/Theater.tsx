import { useCallback, useRef, type ReactNode } from 'react';
import { m } from 'motion/react';
import { Link } from 'react-router-dom';
import { Projector } from './Projector';
import { DustMotes } from './DustMotes';
import { ArrowLeftIcon } from './icons';
import { ease } from './motion';
import { useScene } from './useScene';

interface TheaterProps {
  /** What is projected on the screen — the title card for this page. */
  screen: ReactNode;
  children: ReactNode;
  /** Quiet text under the sheet. */
  foot?: ReactNode;
  wide?: boolean;
  /** A way back, top-left. */
  back?: { to: string; label: string };
  /** Wash the screen out, for the moment something starts. */
  flare?: boolean;
  /** Render children bare instead of inside the default sheet. */
  bare?: boolean;
}

/**
 * The room every signed-out screen happens in: a screen at the top with a
 * title card on it, and the page's one sheet sitting in its light.
 */
export function Theater({ screen, children, foot, wide = false, back, flare = false, bare = false }: TheaterProps) {
  useScene('theater');
  const screenRef = useRef<HTMLDivElement>(null);

  // The canvas reports where its two lights are; the spill below the screen
  // follows them. Written straight to style — no React render per frame.
  const onLights = useCallback((amberX: number, tealX: number) => {
    const el = screenRef.current;
    if (!el) return;
    el.style.setProperty('--spill-a', `${(amberX * 100).toFixed(1)}%`);
    el.style.setProperty('--spill-b', `${(tealX * 100).toFixed(1)}%`);
  }, []);

  return (
    <div className="theater">
      <div className="beam" aria-hidden="true" />
      <DustMotes />

      {back && (
        <Link to={back.to} className="btn btn--ghost btn--sm theater__back" data-light="">
          <ArrowLeftIcon size={18} />
          <span>{back.label}</span>
        </Link>
      )}

      <header className="theater__screen-wrap">
        <m.div
          ref={screenRef}
          className="theater__screen"
          initial={{ opacity: 0, scaleY: 0.02, scaleX: 0.9 }}
          animate={{ opacity: 1, scaleY: 1, scaleX: 1 }}
          transition={{ duration: 0.85, ease: ease.out }}
        >
          <Projector className="theater__canvas" interactive onLights={onLights} flare={flare} />
          <div className="theater__title">{screen}</div>
        </m.div>
      </header>

      <m.main
        className={['theater__seats', wide && 'theater__seats--wide'].filter(Boolean).join(' ')}
        initial={{ opacity: 0, y: 24 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.7, ease: ease.out, delay: 0.35 }}
      >
        {bare ? children : <div className="sheet theater__sheet">{children}</div>}
      </m.main>

      {foot && (
        <m.footer
          className="theater__foot"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ duration: 0.6, delay: 0.7 }}
        >
          {foot}
        </m.footer>
      )}
    </div>
  );
}
