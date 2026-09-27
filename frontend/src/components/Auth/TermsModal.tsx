import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { api } from '../../services/api';
import { Button } from '../ui/Button';
import { AlertIcon, ChevronDownIcon, ShieldIcon } from '../ui/icons';
import { ease, spring } from '../ui/motion';
import { useScene } from '../ui/useScene';

interface TermsModalProps {
  isOpen: boolean;
  onAccept: () => void;
  /**
   * Way out for a reader who will not agree. Optional only so the modal stays
   * usable without one; the gate in App.tsx always passes a sign-out, because
   * the modal is the entire screen there and refusing has to lead somewhere.
   */
  onDecline?: () => void;
}

/**
 * The House Rules, as the whole screen.
 *
 * A reading-progress line runs along the top of the document so the reader
 * can see how much is left, and the accept button unlatches only once they
 * have reached the end — see checkAtBottom for the two ways that can happen.
 */
export function TermsModal({ isOpen, onAccept, onDecline }: TermsModalProps) {
  useScene('theater');
  const [terms, setTerms] = useState<{ version: string; content: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const progressRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (isOpen) {
      loadTerms();
    }
  }, [isOpen]);

  const loadTerms = async () => {
    try {
      const data = await api.getTerms();
      setTerms(data);
    } catch {
      setError('The house rules did not load. Check your connection and reload the page.');
    } finally {
      setIsLoading(false);
    }
  };

  /**
   * The bottom of the terms is "reached" either by scrolling there or by the
   * whole document being visible at once — on a tall window the text fits with
   * room to spare, and a box that cannot scroll never fires a scroll event.
   * Gating purely on onScroll left the accept button permanently disabled for
   * anyone whose viewport was taller than ~960px.
   *
   * The same pass drives the reading-progress line, written straight to its
   * style so scrolling does not re-render the document.
   */
  const checkAtBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const scrollable = el.scrollHeight - el.clientHeight;
    const progress = scrollable <= 0 ? 1 : Math.min(1, el.scrollTop / scrollable);
    progressRef.current?.style.setProperty('transform', `scaleX(${progress})`);
    if (el.scrollHeight - el.scrollTop <= el.clientHeight + 50) {
      setHasScrolledToBottom(true);
    }
  }, []);

  useLayoutEffect(() => {
    // Only once the real text is on screen. The loading placeholder is a single
    // line that always fits, and unlatching on that would hand out the button
    // before there was anything to read.
    const el = bodyRef.current;
    if (!terms || !el) return;

    checkAtBottom();

    // Re-check as the box or its contents are resized: window resizes, and
    // late-arriving webfonts reflowing the text either way across the
    // fits/overflows line.
    const observer = new ResizeObserver(checkAtBottom);
    observer.observe(el);
    if (el.firstElementChild) observer.observe(el.firstElementChild);
    return () => observer.disconnect();
  }, [terms, checkAtBottom]);

  const handleAccept = async () => {
    setIsAccepting(true);
    setError(null);

    try {
      await api.acceptTerms();
      onAccept();
    } catch {
      setError('Accepting didn’t go through. Try again.');
    } finally {
      setIsAccepting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div className="rules">
      <m.section
        className="sheet rules__sheet"
        aria-labelledby="rules-title"
        initial={{ opacity: 0, y: 28, filter: 'blur(8px)' }}
        animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
        transition={{ duration: 0.7, ease: ease.out }}
      >
        <header className="rules__head">
          <span className="rules__badge" aria-hidden="true">
            <ShieldIcon size={22} />
          </span>
          <div>
            <h1 id="rules-title" className="rules__title">
              House rules
            </h1>
            <p className="rules__sub">
              {terms ? `Version ${terms.version}. ` : ''}Read them through once, then you’re in.
            </p>
          </div>
        </header>

        <div className="rules__progress" aria-hidden="true">
          <span ref={progressRef} />
        </div>

        <div ref={bodyRef} className="rules__doc" onScroll={checkAtBottom} tabIndex={0} aria-label="House rules text">
          {isLoading ? (
            <p className="muted" style={{ padding: '24px 0', textAlign: 'center' }}>
              Loading the house rules…
            </p>
          ) : terms ? (
            <div className="rules__text">
              {terms.content.split('\n').map((line, i) => {
                if (line.startsWith('# ')) return <h2 key={i}>{line.slice(2)}</h2>;
                if (line.startsWith('## ')) return <h3 key={i}>{line.slice(3)}</h3>;
                if (line.startsWith('- ')) {
                  return (
                    <p key={i} className="rules__li">
                      {line.slice(2)}
                    </p>
                  );
                }
                if (line.trim()) return <p key={i}>{line}</p>;
                return null;
              })}
            </div>
          ) : (
            <p style={{ color: 'var(--exit)', padding: '24px 0', textAlign: 'center' }}>Failed to load.</p>
          )}
        </div>

        <footer className="rules__foot">
          <AnimatePresence initial={false}>
            {!hasScrolledToBottom && (
              <m.p
                className="rules__hint"
                initial={{ opacity: 0, height: 0 }}
                animate={{ opacity: 1, height: 'auto' }}
                exit={{ opacity: 0, height: 0 }}
                transition={spring.soft}
              >
                <ChevronDownIcon size={16} className="rules__hint-arrow" />
                Scroll to the bottom to accept
              </m.p>
            )}
          </AnimatePresence>
          {error && (
            <div className="notice notice--error" role="alert">
              <AlertIcon size={18} />
              <span>{error}</span>
            </div>
          )}
          <div className="rules__actions">
            {onDecline && (
              <Button variant="ghost" onClick={onDecline}>
                No thanks, sign me out
              </Button>
            )}
            <Button
              variant="primary"
              size="lg"
              magnetic
              onClick={handleAccept}
              loading={isAccepting}
              disabled={!hasScrolledToBottom || isAccepting || isLoading}
            >
              {isAccepting ? 'Accepting…' : 'I accept'}
            </Button>
          </div>
        </footer>
      </m.section>
    </div>
  );
}
