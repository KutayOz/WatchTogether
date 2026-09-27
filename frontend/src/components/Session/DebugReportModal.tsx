import { useRef, useState } from 'react';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { CheckIcon, CopyIcon } from '../ui/icons';
import { sparkle } from '../ui/interactions';

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
  const copyRef = useRef<HTMLButtonElement>(null);

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

  const copy = async () => {
    // Select first, whatever happens next: if the write is refused, the text is
    // already highlighted and Cmd+C works.
    textRef.current?.focus();
    textRef.current?.select();
    try {
      await navigator.clipboard.writeText(report);
      setCopiedReport({ report, ok: true });
      sparkle(copyRef.current);
    } catch {
      setCopiedReport({ report, ok: false });
    }
  };

  // `platform` is deprecated and absent in some embedders, so this reads it
  // defensively: a wrong key hint is a nuisance, a throw inside the error
  // branch loses the report itself.
  const copyKey = /mac|iphone|ipad/i.test(navigator.platform ?? navigator.userAgent ?? '') ? '⌘C' : 'Ctrl+C';

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title="Debug report"
      description="The last few minutes of this call, as text. It stays on this machine until you paste it somewhere."
      width={880}
      footerSplit
      footer={
        <>
          <span className="muted" role="status" style={{ fontSize: '0.925rem' }}>
            {copied === 'ok' && 'Copied. Paste it wherever you’re reporting this.'}
            {copied === 'failed' && `The browser blocked the clipboard. The text is selected, press ${copyKey}.`}
          </span>
          <div className="cluster">
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
            <Button
              ref={copyRef}
              variant="primary"
              icon={copied === 'ok' ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
              onClick={copy}
              data-autofocus=""
            >
              {copied === 'ok' ? 'Copied' : 'Copy report'}
            </Button>
          </div>
        </>
      }
    >
      <textarea
        ref={textRef}
        className="debug-text"
        readOnly
        value={report}
        spellCheck={false}
        aria-label="Debug report text"
      />
    </Modal>
  );
}
