import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import {
  Sketchbook,
  SectionTitle,
  StickerButton,
  BackButton,
  BurstSticker,
  TagSticker,
  Chibi,
  SpeechBubble,
} from '../manga';

export function JoinSession() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const { user } = useAuthContext();
  const [isLoading, setIsLoading] = useState(true);
  const [isJoining, setIsJoining] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [creatorName, setCreatorName] = useState<string | null>(null);
  const [isInvalid, setIsInvalid] = useState(false);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);

  useEffect(() => {
    if (token && user) {
      validateInvite();
    } else if (!user) {
      setIsLoading(false);
    }
  }, [token, user]);

  const validateInvite = async () => {
    try {
      const result = await api.validateSessionInvite(token!);
      if (result.valid) {
        setCreatorName(result.creatorDisplayName || null);
      } else {
        setIsInvalid(true);
        setInvalidMessage(result.message || 'Invalid invite link');
      }
    } catch {
      setIsInvalid(true);
      setInvalidMessage('Failed to validate invite link');
    } finally {
      setIsLoading(false);
    }
  };

  const handleJoin = async () => {
    setIsJoining(true);
    setError(null);
    try {
      const result = await api.joinWithSessionInvite(token!);
      if (result.success && result.sessionId) {
        navigate(`/session/${result.sessionId}`);
      } else {
        setError('Failed to join session');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to join session');
    } finally {
      setIsJoining(false);
    }
  };

  if (!user) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <Sketchbook style={{ width: '100%', maxWidth: 520 }}>
            <div style={{ textAlign: 'center' }}>
              <SectionTitle size={36} underline="purple">LOGIN FIRST</SectionTitle>
              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
                <Chibi who="sprout" pose="wave" size={140} />
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 14, color: 'rgba(26,20,23,0.7)' }}>
                you'll need to be signed in to join this session.
              </p>
              <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
                <Link to="/login" state={{ returnTo: `/join/${token}` }} style={{ textDecoration: 'none' }}>
                  <StickerButton color="pink" size="md" sfx="TAP!">
                    SIGN IN
                  </StickerButton>
                </Link>
              </div>
            </div>
          </Sketchbook>
        </div>
      </div>
    );
  }

  if (isLoading) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
        <div className="hand" style={{ fontSize: 26, color: 'var(--purple)' }}>
          opening the invite…
        </div>
      </div>
    );
  }

  if (isInvalid) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <Sketchbook style={{ width: '100%', maxWidth: 520 }}>
            <div style={{ textAlign: 'center' }}>
              <SectionTitle size={36} underline="orange">LINK BROKEN</SectionTitle>
              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
                <BurstSticker bg="var(--orange)" rot={-4} w={220} h={140}>
                  OOPS!
                </BurstSticker>
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 14 }}>{invalidMessage}</p>
              <p className="hand" style={{ fontSize: 16, marginTop: 6, color: 'rgba(26,20,23,0.55)' }}>
                session invite links expire after 15 minutes &amp; can only be used once.
              </p>
              <div className="row" style={{ justifyContent: 'center', marginTop: 24 }}>
                <Link to="/" style={{ textDecoration: 'none' }}>
                  <BackButton>go to lobby</BackButton>
                </Link>
              </div>
            </div>
          </Sketchbook>
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
        <Sketchbook style={{ width: '100%', maxWidth: 560 }}>
          <div className="row" style={{ alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
            <SectionTitle size={36} underline="pink">JOIN SESSION</SectionTitle>
            <TagSticker color="orange" rot={4}>INVITED</TagSticker>
          </div>

          <div style={{ display: 'flex', alignItems: 'flex-start', gap: 16, marginTop: 22, flexWrap: 'wrap' }}>
            <Chibi who="mochi" pose="peace" size={130} />
            <SpeechBubble kind="oval" color="cream" style={{ maxWidth: 340 }}>
              <span style={{ fontFamily: 'var(--font-body)', fontWeight: 700 }}>
                {creatorName ? (
                  <>
                    <span style={{ color: 'var(--purple)' }}>{creatorName}</span> is waiting to hang out ♥
                  </>
                ) : (
                  <>someone is waiting for you ♥</>
                )}
              </span>
            </SpeechBubble>
          </div>

          {error && (
            <div className="shake" style={{ marginTop: 16 }}>
              <BurstSticker bg="var(--orange)" rot={-4} w={200} h={130}>
                OOPS!
              </BurstSticker>
              <div className="hand" style={{ fontSize: 18, marginTop: 6 }}>{error}</div>
            </div>
          )}

          <div className="row" style={{ gap: 14, marginTop: 24, flexWrap: 'wrap' }}>
            <StickerButton color="pink" size="md" sfx="WHOOSH!" onClick={handleJoin} disabled={isJoining}>
              {isJoining ? 'JOINING…' : 'JOIN!'}
            </StickerButton>
            <Link to="/" style={{ textDecoration: 'none' }}>
              <BackButton>nevermind</BackButton>
            </Link>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
