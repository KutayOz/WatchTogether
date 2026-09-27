import { useState, useEffect, useRef } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { Modal } from '../ui/Modal';
import { Button } from '../ui/Button';
import { ScrambleText } from '../ui/ScrambleText';
import { AlertIcon, CheckIcon, CopyIcon, TicketIcon, TrashIcon } from '../ui/icons';
import { shake, sparkle } from '../ui/interactions';
import { ease } from '../ui/motion';

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  remainingSlots: number;
  /** Root admin has no quota cap. When true, the "X left" badge reads
   *  "Unlimited" and the disabled-on-zero check is skipped — the backend will
   *  still respond to the create call regardless of how many links exist. */
  isUnlimited?: boolean;
  onInvitationSent: () => void;
}

function formatTimeLeft(diffMs: number): string {
  const totalSeconds = Math.max(0, Math.floor(diffMs / 1000));
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes.toString().padStart(2, '0')}m`;
  return `${minutes}:${seconds.toString().padStart(2, '0')}`;
}

export function InviteModal({ isOpen, onClose, remainingSlots, isUnlimited = false, onInvitationSent }: InviteModalProps) {
  const { refreshUser } = useAuthContext();
  const [isGenerating, setIsGenerating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState<number | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);
  const copyRef = useRef<HTMLButtonElement>(null);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (isOpen) {
      checkActiveLink();
    }
  }, [isOpen]);

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

  useEffect(() => {
    if (!expiresAt) {
      setTimeLeft(null);
      return;
    }

    const updateTimeLeft = () => {
      const now = new Date();
      const expiry = new Date(expiresAt);
      const diff = expiry.getTime() - now.getTime();

      if (diff <= 0) {
        setTimeLeft('Expired');
        setInviteUrl(null);
        setExpiresAt(null);
        return;
      }

      setTimeLeft(formatTimeLeft(diff));
    };

    updateTimeLeft();
    const interval = setInterval(updateTimeLeft, 1000);
    return () => clearInterval(interval);
  }, [expiresAt]);

  const checkActiveLink = async () => {
    try {
      const result = await api.getActiveInviteLink();
      if (result.hasActiveLink && result.expiresAt) {
        setExpiresAt(result.expiresAt);
      }
    } catch {
      // Ignore - no active link
    }
  };

  const handleGenerateLink = async () => {
    setError(null);
    setIsGenerating(true);

    try {
      const result = await api.generateInviteLink();
      if (result.success && result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
        setExpiresAt(result.expiresAt ?? null);
        onInvitationSent();
        await refreshUser();
      } else {
        setError(result.message || 'Failed to generate invite link');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate invite link');
    } finally {
      setIsGenerating(false);
    }
  };

  const handleRevokeLink = async () => {
    try {
      await api.revokeInviteLink();
      setInviteUrl(null);
      setExpiresAt(null);
      onInvitationSent();
      await refreshUser();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to revoke link');
    }
  };

  const handleCopy = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setCopied(true);
      sparkle(copyRef.current);
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copying was blocked. Select the link and copy it by hand.');
    }
  };

  const handleClose = () => {
    setError(null);
    setCopied(false);
    onClose();
  };

  const hasOutstanding = !!expiresAt && !inviteUrl;
  const outOfInvites = !isUnlimited && remainingSlots === 0;

  return (
    <Modal
      isOpen={isOpen}
      onClose={handleClose}
      width={540}
      title={inviteUrl ? 'Your invite is ready' : 'Invite someone new'}
      description={
        inviteUrl
          ? 'Send this to the person you’re inviting. Anyone with the link can use it, so send it privately.'
          : 'This makes a one-time link for creating an account. It works once and expires after 48 hours.'
      }
      footerSplit
      footer={
        inviteUrl ? (
          <>
            <Button variant="ghost" icon={<TrashIcon size={17} />} onClick={handleRevokeLink}>
              Revoke
            </Button>
            <div className="cluster">
              <Button variant="secondary" onClick={handleClose}>
                Done
              </Button>
              <Button
                ref={copyRef}
                variant="primary"
                icon={copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
                onClick={handleCopy}
                data-autofocus=""
              >
                {copied ? 'Copied' : 'Copy link'}
              </Button>
            </div>
          </>
        ) : (
          <>
            <span className={isUnlimited ? 'chip chip--amber' : 'chip'}>
              {isUnlimited ? 'Unlimited invites' : `${remainingSlots} left`}
            </span>
            <div className="cluster">
              <Button variant="ghost" onClick={handleClose}>
                Not now
              </Button>
              <Button
                variant="primary"
                icon={<TicketIcon size={18} />}
                onClick={handleGenerateLink}
                loading={isGenerating}
                disabled={isGenerating || hasOutstanding || outOfInvites}
                data-autofocus=""
              >
                {isGenerating ? 'Making link…' : 'Make invite link'}
              </Button>
            </div>
          </>
        )
      }
    >
      <AnimatePresence mode="wait" initial={false}>
        {inviteUrl ? (
          <m.div
            key="link"
            className="invite-ticket"
            initial={{ opacity: 0, y: 24, rotate: -2, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, rotate: 0, scale: 1 }}
            exit={{ opacity: 0, y: -10 }}
            transition={{ type: 'spring', stiffness: 300, damping: 22 }}
          >
            <div className="invite-ticket__label">Invite link</div>
            <ScrambleText text={inviteUrl} className="invite-ticket__url" />
            <div className="invite-ticket__meta">
              Expires in <span className="tabular">{timeLeft ?? '…'}</span>. Works once.
            </div>
          </m.div>
        ) : (
          <m.div
            key="plan"
            className="stack"
            style={{ ['--gap' as string]: '14px' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0, transition: { duration: 0.12 } }}
            transition={{ duration: 0.3, ease: ease.out }}
          >
            <ol className="invite-steps">
              <li>Make the link here.</li>
              <li>Send it to them however you usually talk.</li>
              <li>They open it and pick a name. That’s their account.</li>
            </ol>

            {hasOutstanding && (
              <div className="notice notice--warn">
                <AlertIcon size={18} />
                <span>
                  You already have a link out. It expires in <span className="tabular">{timeLeft}</span>.{' '}
                  <button type="button" className="btn btn--link" onClick={handleRevokeLink}>
                    Revoke it
                  </button>{' '}
                  to make a new one.
                </span>
              </div>
            )}

            {outOfInvites && !hasOutstanding && (
              <div className="notice">
                <AlertIcon size={18} />
                <span>You’ve used all your invites.</span>
              </div>
            )}
          </m.div>
        )}
      </AnimatePresence>

      {error && (
        <div ref={errorRef} className="notice notice--error" role="alert" style={{ marginTop: 14 }}>
          <AlertIcon size={18} />
          <span>{error}</span>
        </div>
      )}
    </Modal>
  );
}
