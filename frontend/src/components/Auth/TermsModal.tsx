import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { api } from '../../services/api';
import { BackButton, SectionTitle, StickerButton, TagSticker } from '../manga';

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

export function TermsModal({ isOpen, onAccept, onDecline }: TermsModalProps) {
  const [terms, setTerms] = useState<{ version: string; content: string } | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isAccepting, setIsAccepting] = useState(false);
  const [hasScrolledToBottom, setHasScrolledToBottom] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

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
      setError('Failed to load terms');
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
   */
  const checkAtBottom = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
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
      setError('Failed to accept terms. Please try again.');
    } finally {
      setIsAccepting(false);
    }
  };

  if (!isOpen) return null;

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        background: 'rgba(26,20,23,0.5)',
        zIndex: 7000,
        display: 'grid',
        placeItems: 'center',
        animation: 'fadeIn 0.25s ease-out forwards',
        padding: 16,
      }}
    >
      <div
        style={{
          width: '100%',
          maxWidth: 640,
          maxHeight: '90vh',
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--cream)',
          border: '4.5px solid var(--ink)',
          boxShadow: '12px 12px 0 var(--ink)',
          animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
          transform: 'rotate(-1.2deg)',
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: '20px 28px 14px',
            borderBottom: '3px dashed var(--ink)',
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            flexWrap: 'wrap',
          }}
        >
          <SectionTitle size={32} underline="pink">
            HOUSE RULES
          </SectionTitle>
          {terms && (
            <TagSticker color="cream" rot={4}>
              v{terms.version}
            </TagSticker>
          )}
        </div>

        {/* Body */}
        <div
          ref={bodyRef}
          className="scroll-y"
          onScroll={checkAtBottom}
          style={{
            flex: 1,
            padding: '20px 28px',
            backgroundImage:
              'repeating-linear-gradient(0deg, transparent 0 27px, rgba(123,63,228,0.18) 27px 28px)',
          }}
        >
          {isLoading ? (
            <div className="hand" style={{ fontSize: 24, color: 'var(--purple)', textAlign: 'center', padding: 32 }}>
              loading the fine print…
            </div>
          ) : terms ? (
            <div style={{ fontFamily: 'var(--font-body)', color: 'var(--ink)', lineHeight: 1.6, fontSize: 14, fontWeight: 600 }}>
              {terms.content.split('\n').map((line, i) => {
                if (line.startsWith('# ')) {
                  return (
                    <h3
                      key={i}
                      style={{
                        fontFamily: 'var(--font-sfx)',
                        fontSize: 24,
                        letterSpacing: 1,
                        margin: '14px 0 8px',
                        color: 'var(--ink)',
                      }}
                    >
                      {line.slice(2)}
                    </h3>
                  );
                }
                if (line.startsWith('## ')) {
                  return (
                    <h4
                      key={i}
                      style={{
                        fontFamily: 'var(--font-sfx)',
                        fontSize: 18,
                        letterSpacing: 1,
                        margin: '12px 0 6px',
                        color: 'var(--purple)',
                      }}
                    >
                      {line.slice(3)}
                    </h4>
                  );
                }
                if (line.startsWith('- ')) {
                  return (
                    <div key={i} style={{ paddingLeft: 16, marginBottom: 4 }}>
                      · {line.slice(2)}
                    </div>
                  );
                }
                if (line.trim()) {
                  return (
                    <p key={i} style={{ margin: '0 0 8px' }}>
                      {line}
                    </p>
                  );
                }
                return null;
              })}
            </div>
          ) : (
            <div className="hand" style={{ color: 'var(--orange-deep)', textAlign: 'center', fontSize: 22 }}>
              failed to load
            </div>
          )}
        </div>

        {/* Footer */}
        <div
          style={{
            padding: '16px 28px 22px',
            borderTop: '3px dashed var(--ink)',
            background: 'rgba(255,79,163,0.06)',
          }}
        >
          {!hasScrolledToBottom && (
            <p
              className="hand"
              style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)', textAlign: 'center', marginTop: 0, marginBottom: 12 }}
            >
              ↓ scroll to the bottom to accept ↓
            </p>
          )}
          {error && (
            <p className="hand" style={{ color: 'var(--orange-deep)', fontSize: 18, textAlign: 'center', margin: '0 0 12px' }}>
              {error}
            </p>
          )}
          <div
            style={{
              display: 'flex',
              justifyContent: 'center',
              alignItems: 'center',
              gap: 18,
              flexWrap: 'wrap',
            }}
          >
            <StickerButton
              color="pink"
              size="md"
              sfx="STAMP!"
              onClick={handleAccept}
              disabled={!hasScrolledToBottom || isAccepting || isLoading}
            >
              {isAccepting ? 'STAMPING…' : 'I ACCEPT'}
            </StickerButton>
            {onDecline && (
              <BackButton onClick={onDecline}>no thanks — sign out</BackButton>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
