import { useEffect, useRef, useState } from 'react';
import { SectionTitle, StickerButton } from '../manga';

interface DebugReportModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** The finished text. Built by the caller when it opens this, not here. */
  report: string;
}

/**
 * The debug report, on screen and selectable.
 *
 * A textarea rather than a copy button alone, deliberately. Clipboard writes
 * need a permission the browser can refuse and a document that is focused, and
 * both fail quietly; a report that silently did not copy is worse than no
 * button, because the person believes they pasted something. So the text is
 * always visible and always selectable, and the button is a convenience on top
 * that says whether it worked.
 *
 * Nothing here leaves the machine. The report is assembled locally and goes
 * wherever the person pastes it — there is no sink, and adding one would be a
 * different decision with a different conversation attached.
 */
export function DebugReportModal({ isOpen, onClose, report }: DebugReportModalProps) {
  const textRef = useRef<HTMLTextAreaElement>(null);

  /*
   * Which report was copied, rather than a bare "copied" flag.
   *
   * Storing the text means the confirmation resets itself when a new report is
   * generated, with no effect to reset it in — and the reset it replaces was
   * a setState inside an effect, which is the pattern React asks you not to
   * write and lints for.
   */
  const [copiedReport, setCopiedReport] = useState<{ report: string; ok: boolean } | null>(null);
  const copied: 'idle' | 'ok' | 'failed' =
    copiedReport?.report === report ? (copiedReport.ok ? 'ok' : 'failed') : 'idle';

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

  const copy = async () => {
    // Select first, whatever happens next: if the write is refused, the text is
    // already highlighted and Cmd+C works.
    textRef.current?.focus();
    textRef.current?.select();
    try {
      await navigator.clipboard.writeText(report);
      setCopiedReport({ report, ok: true });
    } catch {
      setCopiedReport({ report, ok: false });
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="debug-report-title"
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
        onClick={(e) => e.stopPropagation()}
        style={{
          background: 'var(--cream)',
          border: '4px solid var(--ink)',
          boxShadow: '8px 8px 0 var(--ink)',
          padding: '24px 28px',
          maxWidth: 860,
          width: '100%',
          maxHeight: '86vh',
          display: 'flex',
          flexDirection: 'column',
          transform: 'rotate(-0.4deg)',
        }}
      >
        <div id="debug-report-title" style={{ marginBottom: 6 }}>
          <SectionTitle size={30} underline="purple">
            DEBUG REPORT
          </SectionTitle>
        </div>

        <p
          className="hand"
          style={{ fontSize: 17, color: 'rgba(26,20,23,0.65)', margin: '0 0 12px' }}
        >
          the last few minutes of this call, as text. copy it into a bug report —
          it stays on this machine until you paste it somewhere.
        </p>

        <textarea
          ref={textRef}
          readOnly
          value={report}
          spellCheck={false}
          aria-label="debug report text"
          style={{
            flex: 1,
            minHeight: 320,
            width: '100%',
            resize: 'vertical',
            // Monospace is not decoration here: the timeline is column-aligned
            // and a proportional font makes it unreadable.
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
            fontSize: 12,
            lineHeight: 1.45,
            padding: 12,
            border: '3px solid var(--ink)',
            borderRadius: 4,
            background: 'var(--cream-deep)',
            color: 'var(--ink)',
            whiteSpace: 'pre',
            overflowWrap: 'normal',
            overflowX: 'auto',
          }}
        />

        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 14,
            marginTop: 14,
            flexWrap: 'wrap',
          }}
        >
          <StickerButton color="purple" size="md" sfx="COPY" onClick={copy}>
            COPY REPORT
          </StickerButton>
          <StickerButton color="cream" size="md" onClick={onClose}>
            CLOSE
          </StickerButton>
          {copied === 'ok' && (
            <span className="hand" style={{ fontSize: 18, color: 'var(--purple)' }}>
              copied — paste it wherever you are reporting this
            </span>
          )}
          {copied === 'failed' && (
            <span className="hand" style={{ fontSize: 18, color: 'var(--orange-deep)' }}>
              the browser refused the clipboard — the text is selected, press
              {' '}
              {/* `platform` is deprecated and absent in some embedders, so this
                  reads it defensively: a wrong key hint is a nuisance, a throw
                  inside the error branch loses the report itself. */}
              {/mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent ?? '')
                ? '⌘C'
                : 'Ctrl+C'}
            </span>
          )}
        </div>
      </div>
    </div>
  );
}
