import { logger } from '../../services/logger';
import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { InviteModal } from '../Invitation/InviteModal';
import type { InvitationSlots } from '../../types';
import {
  SectionTitle,
  TagSticker,
  StickerButton,
  ComicPanel,
  SpeedLines,
  BurstSticker,
  Doodle,
  InkInput,
  BackButton,
} from '../manga';

export function Lobby() {
  const navigate = useNavigate();
  const { user, logout } = useAuthContext();
  const [isCreating, setIsCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showInviteModal, setShowInviteModal] = useState(false);
  const [invitationSlots, setInvitationSlots] = useState<InvitationSlots | null>(null);
  const [joinLink, setJoinLink] = useState('');
  const [isJoiningLink, setIsJoiningLink] = useState(false);

  useEffect(() => {
    if (user) {
      fetchInvitationState();
    }

  }, [user]);

  const fetchInvitationState = async () => {
    try {
      const slots = await api.getAvailableSlots();
      setInvitationSlots(slots);
    } catch (err) {
      logger.error('Failed to fetch invitation state:', err);
    }
  };

  const handleCreateSession = async () => {
    setIsCreating(true);
    setError(null);
    try {
      const { sessionId } = await api.createSession();
      navigate(`/session/${sessionId}`, { state: { isCreator: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create session');
    } finally {
      setIsCreating(false);
    }
  };

  const handleJoinFromLink = () => {
    const trimmed = joinLink.trim();
    if (!trimmed) return;
    try {
      // Resolve against our own origin. CRITICAL: we then reject any URL whose
      // origin doesn't match ours — without this check, a polished phishing link
      // (https://evil.com/join/<attacker-token>) resolves to pathname /join/<token>
      // and we'd silently navigate the user into the attacker's session, where the
      // attacker is the other peer.
      const url = new URL(trimmed, window.location.origin);
      if (url.origin !== window.location.origin) {
        setError('That invite is for a different site. Only paste WatchTogether links here.');
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
      setError('That link doesn\'t look like a session invite.');
    } catch {
      setError('Couldn\'t read that link. Paste the whole URL.');
    }
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isUnlimited = invitationSlots?.isUnlimited ?? false;
  // For unlimited (root) users the backend sends MaxSlots = int.MaxValue.
  // We can't iterate ~2 billion tickets in the React tree — clamp to
  // "used tickets + 1 empty slot" so the lobby always shows one tear-off
  // tile available to click. The next render after a new invite naturally
  // grows by one used tile + one fresh empty.
  const remainingSlots = isUnlimited
    ? Number.POSITIVE_INFINITY  // sentinel for the modal's disabled check
    : invitationSlots?.remainingSlots ?? 0;
  const usedSlots = invitationSlots?.usedSlots ?? 0;
  const totalSlots = isUnlimited
    ? usedSlots + 1
    : invitationSlots?.maxSlots ?? 0;
  // The "X left" label in the corner of the ticket book. Show "∞" rather
  // than the int.MaxValue numeral the backend sends for unlimited users.
  const remainingLabel = isUnlimited ? '∞' : String(remainingSlots);
  // Backend now returns these directly — no more guessing from a boolean.
  const pendingCount = invitationSlots?.pendingSlots ?? 0;
  const trulyUsedCount = invitationSlots?.trulyUsedSlots ?? 0;

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) 380px', gap: 28 }}>
        {/* MAIN ACTION */}
        <div style={{ position: 'relative', paddingTop: 12, minWidth: 0 }}>
          <div className="row" style={{ gap: 14, alignItems: 'center', flexWrap: 'wrap' }}>
            <div className="hand" style={{ fontSize: 32, color: 'var(--ink)' }}>
              hey,{' '}
              <span style={{ color: 'var(--pink)', textDecoration: 'underline wavy' }}>
                {user?.displayName ?? 'friend'}!
              </span>
            </div>
            <TagSticker color="pink" rot={-3}>
              {new Date().toLocaleDateString(undefined, { weekday: 'long' }).toUpperCase()}
            </TagSticker>
          </div>
          <div className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.6)', marginTop: 4 }}>
            ready to hang? ↓
          </div>

          {/* The big create-session button */}
          <div
            style={{
              position: 'relative',
              marginTop: 40,
              padding: '60px 40px',
              display: 'grid',
              placeItems: 'center',
            }}
          >
            <div style={{ position: 'absolute', left: '50%', top: '50%', transform: 'translate(-50%,-50%)' }}>
              <SpeedLines count={22} radius={260} color="rgba(26,20,23,0.5)" />
            </div>

            <div style={{ position: 'relative', zIndex: 2 }}>
              <StickerButton
                color="pink"
                size="xl"
                sfx="WHOOSH!"
                breathe
                sparks
                style={{ fontSize: 44, padding: '32px 56px 26px' }}
                onClick={handleCreateSession}
                disabled={isCreating}
              >
                {isCreating ? 'CREATING…' : 'CREATE A SESSION'}
              </StickerButton>
            </div>

            <div style={{ position: 'absolute', right: -10, top: 0, zIndex: 3 }}>
              <BurstSticker bg="var(--orange)" rot={14} w={140} h={100}>
                POW!
              </BurstSticker>
            </div>
            <div style={{ position: 'absolute', left: 30, bottom: 30, zIndex: 3, transform: 'rotate(-8deg)' }}>
              <Doodle kind="star" size={40} color="var(--orange)" />
            </div>
          </div>

          {error && (
            <div className="shake" style={{ marginTop: 8 }}>
              <BurstSticker bg="var(--orange)" rot={-4} w={200} h={130}>
                OOPS!
              </BurstSticker>
              <div className="hand" style={{ fontSize: 18, marginTop: 6 }}>{error}</div>
            </div>
          )}

          {/* Join via link */}
          <ComicPanel rotate={-0.6} shadow="ink" style={{ marginTop: 40, padding: '20px 24px' }}>
            <div className="row" style={{ gap: 16, flexWrap: 'wrap', alignItems: 'flex-end' }}>
              <div className="col" style={{ flex: 1, minWidth: 220, gap: 6 }}>
                <span className="hand" style={{ fontSize: 22 }}>got an invite link?</span>
                <InkInput
                  placeholder="paste it here"
                  value={joinLink}
                  onChange={(e) => setJoinLink(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') handleJoinFromLink();
                  }}
                />
              </div>
              <StickerButton
                color="purple"
                sfx="KLIK"
                onClick={() => {
                  setIsJoiningLink(true);
                  handleJoinFromLink();
                  window.setTimeout(() => setIsJoiningLink(false), 400);
                }}
                disabled={!joinLink.trim() || isJoiningLink}
              >
                JOIN
              </StickerButton>
            </div>
          </ComicPanel>

          {/* Footer row — settings + admin door + logout */}
          <div className="row" style={{ marginTop: 36, justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
            <div className="row" style={{ gap: 12 }}>
              <BackButton onClick={handleLogout}>sign out</BackButton>
              <button
                onClick={() => navigate('/settings')}
                className="hand"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 18,
                  color: 'rgba(26,20,23,0.6)',
                  textDecoration: 'underline',
                  textDecorationStyle: 'dashed',
                  textUnderlineOffset: 3,
                  padding: 4,
                }}
              >
                settings
              </button>
            </div>
            {user?.isRootUser && (
              <button
                onClick={() => navigate('/admin')}
                className="hand"
                style={{
                  background: 'transparent',
                  border: 'none',
                  cursor: 'pointer',
                  fontSize: 22,
                  color: 'var(--purple)',
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: 4,
                }}
              >
                <Doodle kind="key" size={32} color="var(--purple)" />
                secret door
              </button>
            )}
          </div>
        </div>

        {/* RIGHT — ticket book */}
        <ComicPanel rotate={0.8} shadow="ink" pad={20}>
          <div className="row" style={{ justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 12 }}>
            <SectionTitle size={28} underline="purple">
              YOUR TICKETS
            </SectionTitle>
            <span className="hand" style={{ fontSize: 16 }}>
              {remainingLabel} left
            </span>
          </div>

          <div className="col" style={{ gap: 14 }}>
            {invitationSlots ? (
              Array.from({ length: totalSlots }, (_, i) => {
                // Layout: truly-used first, then pending, then available.
                const used = i < trulyUsedCount;
                const pending = !used && i < trulyUsedCount + pendingCount;
                const available = i >= usedSlots;
                const label = `invite #${String(i + 1).padStart(3, '0')}`;
                return (
                  <Ticket
                    key={i}
                    label={label}
                    used={used}
                    pending={pending}
                    available={available}
                    onClick={available || pending ? () => setShowInviteModal(true) : undefined}
                  />
                );
              })
            ) : (
              <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)' }}>
                loading ticket book…
              </div>
            )}
          </div>

          <div
            className="hand"
            style={{ fontSize: 16, marginTop: 14, color: 'rgba(26,20,23,0.6)', textAlign: 'center' }}
          >
            ↑ tear off &amp; give to a friend ↑
          </div>
        </ComicPanel>
      </div>

      {/* Invite Modal */}
      <InviteModal
        isOpen={showInviteModal}
        onClose={() => setShowInviteModal(false)}
        remainingSlots={remainingSlots}
        isUnlimited={isUnlimited}
        onInvitationSent={fetchInvitationState}
      />
    </div>
  );
}

/* ──────────────────────────────────────────────────────────── */
/* Ticket — torn-off invitation slip                            */
/* ──────────────────────────────────────────────────────────── */

interface TicketProps {
  label: string;
  used?: boolean;
  pending?: boolean;
  available?: boolean;
  onClick?: () => void;
}

function Ticket({ label, used, pending, available, onClick }: TicketProps) {
  const clickable = !!(available || pending);
  const baseRot = used ? -0.6 : pending ? 0 : 0.6;

  const background =
    used ? 'rgba(26,20,23,0.06)' :
    pending ? 'rgba(255,122,41,0.12)' :
    'var(--cream)';

  const boxShadow =
    available ? '3px 3px 0 var(--pink)' :
    pending ? '3px 3px 0 var(--orange)' :
    'none';

  const checkboxBg =
    available ? 'var(--pink)' :
    pending ? 'var(--orange)' :
    'transparent';

  const subtitle =
    used ? 'already gifted' :
    pending ? 'link out — tap to manage' :
    'tear me off!';

  return (
    <div
      onClick={onClick}
      onMouseEnter={(e) => {
        if (clickable) e.currentTarget.style.transform = 'rotate(0) translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        if (clickable) e.currentTarget.style.transform = `rotate(${baseRot}deg)`;
      }}
      style={{
        position: 'relative',
        border: '2.5px solid var(--ink)',
        borderRadius: 4,
        padding: '12px 14px',
        background,
        transform: `rotate(${baseRot}deg)`,
        cursor: clickable ? 'pointer' : 'default',
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'space-between',
        gap: 12,
        overflow: 'hidden',
        transition: 'transform .15s, box-shadow .15s',
        boxShadow,
      }}
    >
      <span
        style={{ position: 'absolute', left: '70%', top: 0, bottom: 0, borderLeft: '2px dashed var(--ink)' }}
        aria-hidden="true"
      />
      <div className="row" style={{ gap: 10 }}>
        <span
          style={{
            width: 24,
            height: 24,
            border: '2.5px solid var(--ink)',
            borderRadius: 4,
            display: 'grid',
            placeItems: 'center',
            background: checkboxBg,
          }}
          aria-hidden="true"
        >
          {used && <Doodle kind="x" size={18} />}
        </span>
        <div className="col" style={{ gap: 0 }}>
          <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 16, letterSpacing: 1 }}>{label}</span>
          <span
            className="hand"
            style={{
              fontSize: 16,
              color: used ? 'rgba(26,20,23,0.5)' : pending ? 'var(--orange-deep)' : 'var(--ink)',
              textDecoration: used ? 'line-through' : 'none',
            }}
          >
            {subtitle}
          </span>
        </div>
      </div>
      {available && <Doodle kind="sparkle" size={20} color="var(--orange)" />}
      {pending && <Doodle kind="envelope" size={20} color="var(--orange)" />}
    </div>
  );
}
