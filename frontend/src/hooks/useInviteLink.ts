import { type RefObject, useState, useEffect } from 'react';
import { api } from '../services/api';
import { logger } from '../services/logger';

type ShowToast = (toast: { message: string; type: 'info' | 'error' | 'warning' }) => void;

/**
 * One-time session invite link: generation, clipboard copy, and the
 * expiry countdown that auto-clears the link when it lapses. Extracted from
 * SessionRoom. Reads the live session id through `sessionIdRef` (a ref so the
 * generate handler isn't recreated on every session change) and surfaces
 * failures through the injected `showToast`.
 */
export function useInviteLink(sessionIdRef: RefObject<string | null>, showToast: ShowToast) {
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [inviteExpiry, setInviteExpiry] = useState<Date | null>(null);
  const [isGeneratingInvite, setIsGeneratingInvite] = useState(false);
  const [inviteCopied, setInviteCopied] = useState(false);

  const handleGenerateInvite = async () => {
    if (!sessionIdRef.current || isGeneratingInvite) return;
    setIsGeneratingInvite(true);
    try {
      const result = await api.generateSessionInvite(sessionIdRef.current);
      if (result.success && result.inviteUrl) {
        setInviteUrl(result.inviteUrl);
        setInviteExpiry(result.expiresAt ? new Date(result.expiresAt) : null);
      } else {
        showToast({ message: 'Failed to generate invite link', type: 'error' });
      }
    } catch (err) {
      logger.error('[Session] Failed to generate invite:', err);
      showToast({ message: 'Failed to generate invite link', type: 'error' });
    } finally {
      setIsGeneratingInvite(false);
    }
  };

  const handleCopyInvite = async () => {
    if (!inviteUrl) return;
    try {
      await navigator.clipboard.writeText(inviteUrl);
      setInviteCopied(true);
      window.setTimeout(() => setInviteCopied(false), 2000);
    } catch {
      showToast({ message: 'Failed to copy link', type: 'error' });
    }
  };

  const getInviteTimeRemaining = () => {
    if (!inviteExpiry) return null;
    const now = new Date();
    const diff = inviteExpiry.getTime() - now.getTime();
    if (diff <= 0) return 'Expired';
    const minutes = Math.floor(diff / 60000);
    const seconds = Math.floor((diff % 60000) / 1000);
    return `${minutes}:${seconds.toString().padStart(2, '0')}`;
  };

  // Tick once a second so the "time remaining" label re-renders, and auto-clear
  // the link the moment it expires.
  const [, setInviteCountdown] = useState(0);
  useEffect(() => {
    if (!inviteExpiry) return;

    const interval = setInterval(() => {
      const now = new Date();
      const diff = inviteExpiry.getTime() - now.getTime();
      if (diff <= 0) {
        setInviteUrl(null);
        setInviteExpiry(null);
        clearInterval(interval);
      } else {
        setInviteCountdown((prev) => prev + 1);
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [inviteExpiry]);

  return {
    inviteUrl,
    inviteExpiry,
    isGeneratingInvite,
    inviteCopied,
    setInviteUrl,
    setInviteExpiry,
    handleGenerateInvite,
    handleCopyInvite,
    getInviteTimeRemaining,
  };
}
