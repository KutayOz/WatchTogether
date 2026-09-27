import { logger } from '../../services/logger';
import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import { m } from 'motion/react';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { InviteModal } from '../Invitation/InviteModal';
import type { InvitationSlots } from '../../types';
import { AppShell } from '../ui/AppShell';
import { FocusText } from '../ui/FocusText';
import { Projector } from '../ui/Projector';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { AlertIcon, CheckIcon, LinkIcon, PlayIcon, TicketIcon } from '../ui/icons';
import { shake } from '../ui/interactions';
import { cascade, ease, rise } from '../ui/motion';
import './lobby.css';

/** How to say hello depends on when someone is here. */
function greeting(now = new Date()): string {
  const h = now.getHours();
  if (h >= 5 && h < 12) return 'Good morning';
  if (h >= 12 && h < 17) return 'Good afternoon';
  if (h >= 17 && h < 23) return 'Good evening';
  return 'Up late';
}

export function Lobby() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [isCreating, setIsCreating] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [joinError, setJoinError] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [invitationSlots, setInvitationSlots] = useState<InvitationSlots | null>(null);
  const [joinLink, setJoinLink] = useState('');
  const [isJoiningLink, setIsJoiningLink] = useState(false);
  const joinRef = useRef<HTMLFormElement>(null);
  const createErrorRef = useRef<HTMLDivElement>(null);

  const fetchInvitationState = async () => {
    try {
      const slots = await api.getAvailableSlots();
      setInvitationSlots(slots);
    } catch (err) {
      logger.error('Failed to fetch invitation state:', err);
    }
  };

  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    api
      .getAvailableSlots()
      .then((slots) => {
        if (!cancelled) setInvitationSlots(slots);
      })
      .catch((err) => logger.error('Failed to fetch invitation state:', err));
    return () => {
      cancelled = true;
    };
  }, [user]);

  useEffect(() => {
    if (joinError) shake(joinRef.current);
  }, [joinError]);
  useEffect(() => {
    if (createError) shake(createErrorRef.current);
  }, [createError]);

  const handleCreateSession = async () => {
    setIsCreating(true);
    setCreateError(null);
    try {
      const { sessionId } = await api.createSession();
      // A beat for the screen to flare before the room replaces it — the
      // request already took longer than this, so it costs nothing.
      await new Promise((resolve) => window.setTimeout(resolve, 380));
      navigate(`/session/${sessionId}`, { state: { isCreator: true } });
    } catch (err) {
      setCreateError(err instanceof Error ? err.message : 'Failed to create session');
      setIsCreating(false);
    }
  };

  const handleJoinFromLink = () => {
    const trimmed = joinLink.trim();
    if (!trimmed) return;
    setJoinError(null);
    try {
      // Resolve against our own origin. CRITICAL: we then reject any URL whose
      // origin doesn't match ours — without this check, a polished phishing link
      // (https://evil.com/join/<attacker-token>) resolves to pathname /join/<token>
      // and we'd silently navigate the user into the attacker's session, where the
      // attacker is the other peer.
      const url = new URL(trimmed, window.location.origin);
      if (url.origin !== window.location.origin) {
        setJoinError('That link is for a different site. Only paste WatchTogether links here.');
        return;
      }

      // Accept paths like /join/<token>
      const match = url.pathname.match(/^\/join\/([^/]+)\/?$/);
      if (match) {
        navigate(`/join/${match[1]}`);
        return;
      }
      // Or maybe it's a session/<id>
      const sessionMatch = url.pathname.match(/^\/session\/([^/]+)\/?$/);
      if (sessionMatch) {
        navigate(`/session/${sessionMatch[1]}`);
        return;
      }
      setJoinError('That doesn’t look like a session link. It should end in /join/ and a code.');
    } catch {
      setJoinError('Couldn’t read that link. Paste the whole URL.');
    }
  };

  const isUnlimited = invitationSlots?.isUnlimited ?? false;
  // For unlimited (root) users the backend sends no cap. We can't draw
  // infinite tickets — show the spent ones plus one fresh, so there is always
  // one to tear off. The next render after a new invite naturally grows by one.
  const remainingSlots = isUnlimited
    ? Number.POSITIVE_INFINITY // sentinel for the modal's disabled check
    : (invitationSlots?.remainingSlots ?? 0);
  const usedSlots = invitationSlots?.usedSlots ?? 0;
  const totalSlots = isUnlimited ? usedSlots + 1 : (invitationSlots?.maxSlots ?? 0);
  // Root has no cap, and the Worker sends null rather than a sentinel numeral.
  const remainingLabel = isUnlimited ? 'Unlimited' : `${remainingSlots} of ${totalSlots} left`;

  return (
    <AppShell>
      <div className="lobby">
        <header className="lobby__intro">
          <FocusText as="h1" className="lobby__hello" text={`${greeting()}, ${user?.username ?? 'friend'}`} delay={0.15} />
          <m.p
            className="lobby__lede"
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: 0.55, duration: 0.7, ease: ease.out }}
          >
            Start a session and send the link to one person. It’s just the two of you.
          </m.p>
        </header>

        <div className="lobby__grid">
          {/* The screen. Starting a session turns the lamp all the way up. */}
          <m.section
            className="lobby__stage"
            aria-labelledby="start-title"
            initial={{ opacity: 0, scaleY: 0.04 }}
            animate={{ opacity: 1, scaleY: 1 }}
            transition={{ duration: 0.8, ease: ease.out, delay: 0.1 }}
            data-flaring={isCreating ? '' : undefined}
          >
            <Projector className="lobby__canvas" interactive flare={isCreating} />
            <div className="lobby__stage-content">
              <h2 id="start-title" className="sr-only">
                Start a session
              </h2>
              <Button
                variant="primary"
                size="xl"
                magnetic
                icon={<PlayIcon size={22} />}
                onClick={handleCreateSession}
                loading={isCreating}
                disabled={isCreating}
              >
                {isCreating ? 'Setting up…' : 'Start a session'}
              </Button>
              <p className="lobby__stage-note">You’ll check your camera and mic before anyone sees you.</p>
            </div>
          </m.section>

          <m.aside className="lobby__side" variants={cascade(0.1, 0.35)} initial="hidden" animate="shown">
            <m.section className="card lobby__panel" variants={rise} aria-labelledby="join-title">
              <div className="lobby__panel-head">
                <span className="lobby__panel-icon" aria-hidden="true">
                  <LinkIcon size={18} />
                </span>
                <div>
                  <h2 id="join-title" className="section-title">
                    Have a link?
                  </h2>
                  <p className="section-sub">Paste the session link your friend sent.</p>
                </div>
              </div>
              <form
                ref={joinRef}
                className="lobby__join"
                onSubmit={(e) => {
                  e.preventDefault();
                  setIsJoiningLink(true);
                  handleJoinFromLink();
                  window.setTimeout(() => setIsJoiningLink(false), 400);
                }}
              >
                <TextField
                  label="Session link"
                  value={joinLink}
                  onValueChange={(v) => {
                    setJoinLink(v);
                    setJoinError(null);
                  }}
                  placeholder="https://…/join/…"
                  autoComplete="off"
                  autoCapitalize="none"
                  autoCorrect="off"
                  spellCheck={false}
                  inputMode="url"
                  problem={joinError}
                />
                <Button type="submit" variant="teal" disabled={!joinLink.trim() || isJoiningLink}>
                  Join
                </Button>
              </form>
            </m.section>

            <m.section className="card lobby__panel" variants={rise} aria-labelledby="tickets-title">
              <div className="lobby__panel-head">
                <span className="lobby__panel-icon" data-tone="amber" aria-hidden="true">
                  <TicketIcon size={18} />
                </span>
                <div>
                  <h2 id="tickets-title" className="section-title">
                    Invites
                  </h2>
                  <p className="section-sub">Each one lets a new person make an account.</p>
                </div>
                {invitationSlots && <span className="chip chip--amber lobby__left">{remainingLabel}</span>}
              </div>

              {invitationSlots ? (
                <m.ul className="tickets" variants={cascade(0.06, 0.5)} initial="hidden" animate="shown">
                  {Array.from({ length: totalSlots }, (_, i) => {
                    // A slot is either spent or free. The Worker tracks one
                    // active-link count per user, so the book shows
                    // spent-then-free and nothing in between.
                    const used = i < usedSlots;
                    return (
                      <m.li key={i} variants={rise}>
                        <Ticket
                          number={i + 1}
                          used={used}
                          total={isUnlimited ? null : totalSlots}
                          onClick={used ? undefined : () => setShowInviteModal(true)}
                        />
                      </m.li>
                    );
                  })}
                </m.ul>
              ) : (
                <p className="muted" style={{ fontSize: '0.95rem' }}>
                  Loading your invites…
                </p>
              )}
            </m.section>
          </m.aside>
        </div>

        {createError && (
          <div ref={createErrorRef} className="notice notice--error lobby__error" role="alert">
            <AlertIcon size={18} />
            <span>{createError}</span>
          </div>
        )}
      </div>

      <InviteModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        remainingSlots={remainingSlots}
        isUnlimited={isUnlimited}
        onInvitationSent={fetchInvitationState}
      />
    </AppShell>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Ticket — one invite, torn off to give to someone             */
/* ──────────────────────────────────────────────────────────── */

interface TicketProps {
  number: number;
  used: boolean;
  /** Null for root, who has no cap. */
  total: number | null;
  onClick?: () => void;
}

function Ticket({ number, used, total, onClick }: TicketProps) {
  const serial = `No. ${String(number).padStart(3, '0')}`;
  if (used) {
    return (
      <div className="ticket" data-state="used">
        <span className="ticket__body">
          <span className="ticket__no">{serial}</span>
          <span className="ticket__title">Admit one</span>
          <span className="ticket__meta">Given away</span>
        </span>
        <span className="ticket__stub" aria-hidden="true">
          <CheckIcon size={18} />
        </span>
        <span className="ticket__stamp" aria-hidden="true">
          Used
        </span>
      </div>
    );
  }
  return (
    <button
      type="button"
      className="ticket"
      data-state="available"
      data-tilt=""
      data-light=""
      onClick={onClick}
      aria-label={total ? `Make an invite link (invite ${number} of ${total})` : 'Make an invite link'}
    >
      <span className="ticket__body">
        <span className="ticket__no">{serial}</span>
        <span className="ticket__title">Admit one</span>
        <span className="ticket__meta">Make an invite link</span>
      </span>
      <span className="ticket__stub" aria-hidden="true">
        <TicketIcon size={20} />
      </span>
    </button>
  );
}
