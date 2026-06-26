import { useState, useEffect } from 'react';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import {
  SectionTitle,
  TagSticker,
  StickerButton,
  BackButton,
  Doodle,
  BurstSticker,
} from '../manga';

interface InviteModalProps {
  isOpen: boolean;
  onClose: () => void;
  remainingSlots: number;
  /** Root admin has no quota cap. When true, the "X LEFT" badge renders as
   *  "∞ LEFT" and the disabled-on-zero check is skipped — the backend will
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
  const [expiresAt, setExpiresAt] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [timeLeft, setTimeLeft] = useState<string | null>(null);

  useEffect(() => {
    if (isOpen) {
      checkActiveLink();
    }

  }, [isOpen]);

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
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Failed to copy to clipboard');
    }
  };

  const handleClose = () => {
    setError(null);
    setCopied(false);
    onClose();
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
      onClick={handleClose}
    >
      {/* Postcard */}
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          position: 'relative',
          width: '100%',
          maxWidth: 600,
          background: 'var(--cream)',
          border: '4.5px solid var(--ink)',
          boxShadow: '12px 12px 0 var(--ink)',
          animation: 'postcardIn 0.55s cubic-bezier(.34,1.56,.64,1)',
          transform: 'rotate(-1.5deg)',
        }}
      >
        <div style={{ padding: '26px 32px 22px', position: 'relative' }}>
          <div className="row" style={{ gap: 12, alignItems: 'center', flexWrap: 'wrap' }}>
            <SectionTitle size={38} underline="pink">
              INVITE!
            </SectionTitle>
            {!inviteUrl && (isUnlimited || remainingSlots > 0) && (
              <TagSticker color="orange" rot={4}>
                {isUnlimited ? '∞' : remainingSlots} LEFT
              </TagSticker>
            )}
          </div>

          {!inviteUrl ? (
            <>
              <p className="hand" style={{ fontSize: 22, marginTop: 16, color: 'rgba(26,20,23,0.7)' }}>
                tear this off &amp; give it to{' '}
                <span style={{ color: 'var(--purple)' }}>your favorite person</span>
              </p>

              {/* How-it-works ledger */}
              <div
                style={{
                  marginTop: 18,
                  border: '3px solid var(--ink)',
                  padding: '14px 18px',
                  background: 'rgba(123,63,228,0.06)',
                  transform: 'rotate(0.4deg)',
                }}
              >
                <div style={{ fontFamily: 'var(--font-sfx)', fontSize: 14, letterSpacing: 1, color: 'var(--purple)', marginBottom: 8 }}>
                  THE PLAN
                </div>
                <ol className="hand" style={{ fontSize: 18, color: 'var(--ink)', margin: 0, paddingLeft: 22, lineHeight: 1.5 }}>
                  <li>generate a one-time link below</li>
                  <li>send it to a friend (whatsapp, dms, whatever)</li>
                  <li>they click it &amp; make an account</li>
                </ol>
                <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)', marginTop: 8 }}>
                  expires after 48h · one use only
                </div>
              </div>

              {expiresAt && !inviteUrl && (
                <div
                  style={{
                    marginTop: 16,
                    border: '3px solid var(--ink)',
                    background: 'var(--orange)',
                    padding: '10px 14px',
                  }}
                >
                  <span className="hand" style={{ fontSize: 18, color: 'var(--ink)' }}>
                    you already have an active link expiring in {timeLeft}.{' '}
                    <button
                      type="button"
                      onClick={handleRevokeLink}
                      style={{
                        background: 'transparent',
                        border: 'none',
                        textDecoration: 'underline',
                        cursor: 'pointer',
                        fontFamily: 'var(--font-hand)',
                        fontWeight: 700,
                        fontSize: 18,
                        color: 'var(--ink)',
                        padding: 0,
                      }}
                    >
                      revoke it
                    </button>{' '}
                    to make a new one.
                  </span>
                </div>
              )}

              {error && (
                <div className="shake" style={{ marginTop: 16 }}>
                  <BurstSticker bg="var(--orange)" rot={-4} w={180} h={120}>
                    OOPS!
                  </BurstSticker>
                  <div className="hand" style={{ fontSize: 18, marginTop: 6 }}>{error}</div>
                </div>
              )}

              <div className="row" style={{ marginTop: 22, gap: 12, flexWrap: 'wrap' }}>
                <StickerButton
                  color="pink"
                  sfx="STAMP!"
                  onClick={handleGenerateLink}
                  disabled={isGenerating || (!!expiresAt && !inviteUrl) || (!isUnlimited && remainingSlots === 0)}
                >
                  {isGenerating ? 'STAMPING…' : 'MAIL IT!'}
                </StickerButton>
                <span style={{ flex: 1 }} />
                <BackButton onClick={handleClose}>put it away</BackButton>
              </div>
            </>
          ) : (
            <>
              <p className="hand" style={{ fontSize: 22, marginTop: 16, color: 'rgba(26,20,23,0.7)' }}>
                here's the link — send it to{' '}
                <span style={{ color: 'var(--purple)' }}>your favorite person</span>
              </p>

              {/* Tear-off line */}
              <div style={{ marginTop: 14, position: 'relative', display: 'flex', alignItems: 'center' }}>
                <Doodle kind="x" size={20} color="var(--ink)" style={{ marginRight: -6 }} />
                <span style={{ flex: 1, borderTop: '2px dashed var(--ink)', margin: '0 4px' }} />
              </div>
              <div className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.55)', marginTop: -2, marginLeft: 22 }}>
                ✂  cut here
              </div>

              <div
                style={{
                  marginTop: 8,
                  border: '3px solid var(--ink)',
                  padding: '16px 18px',
                  background: 'rgba(255,79,163,0.08)',
                  position: 'relative',
                  transform: 'rotate(0.5deg)',
                }}
              >
                <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 14, letterSpacing: 1, color: 'var(--purple)' }}>
                  YOUR LINK
                </span>
                <div
                  style={{
                    fontFamily: 'monospace',
                    fontSize: 15,
                    fontWeight: 700,
                    marginTop: 6,
                    userSelect: 'all',
                    wordBreak: 'break-all',
                  }}
                >
                  {inviteUrl}
                </div>
                <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)', marginTop: 8 }}>
                  expires in {timeLeft ?? '…'} · one use only
                </div>
              </div>

              {error && (
                <div className="hand" style={{ marginTop: 12, color: 'var(--orange-deep)', fontSize: 18 }}>
                  {error}
                </div>
              )}

              <div className="row" style={{ marginTop: 22, gap: 12, flexWrap: 'wrap' }}>
                <StickerButton color={copied ? 'orange' : 'pink'} sfx="KLIK" onClick={handleCopy}>
                  {copied ? 'COPIED!' : 'COPY LINK'}
                </StickerButton>
                <StickerButton color="cream" size="sm" sfx="KLIK" onClick={handleRevokeLink}>
                  REVOKE
                </StickerButton>
                <span style={{ flex: 1 }} />
                <BackButton onClick={handleClose}>done</BackButton>
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
