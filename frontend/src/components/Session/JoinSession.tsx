import { useState, useEffect, useRef } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { m } from 'motion/react';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { Theater } from '../ui/Theater';
import { FocusText } from '../ui/FocusText';
import { Button } from '../ui/Button';
import { Lights } from '../ui/Lights';
import { AlertIcon, LinkIcon, PlayIcon } from '../ui/icons';
import { shake } from '../ui/interactions';

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
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (token && user) {
      validateInvite();
    } else if (!user) {
      setIsLoading(false);
    }
  }, [token, user]);

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

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
      <Theater screen={<FocusText as="h1" className="theater__kicker" text="Someone saved you a seat" delay={0.3} />}>
        <div className="status-card">
          <span className="status-card__icon" data-tone="wait" aria-hidden="true">
            <LinkIcon size={26} />
          </span>
          <h2>Sign in to join</h2>
          <p>You need to be signed in to join this session. The link will still work after.</p>
          <Link to="/login" state={{ returnTo: `/join/${token}` }} className="btn btn--primary" data-light="">
            <span>Sign in</span>
          </Link>
        </div>
      </Theater>
    );
  }

  if (isLoading) {
    return (
      <Theater screen={<p className="theater__kicker">Opening the invite…</p>}>
        <div className="status-card">
          <span className="loading-line">
            <span className="btn__spinner" aria-hidden="true" />
            Checking the link
          </span>
        </div>
      </Theater>
    );
  }

  if (isInvalid) {
    return (
      <Theater screen={<FocusText as="h1" className="theater__kicker" text="This session link is spent" />}>
        <div className="status-card">
          <span className="status-card__icon" aria-hidden="true">
            <AlertIcon size={26} />
          </span>
          <h2>This link can’t be used</h2>
          <p>{invalidMessage}</p>
          <p className="muted">Session links expire after 15 minutes and work once. Ask for a fresh one.</p>
          <Link to="/" className="btn btn--secondary" data-light="">
            <span>Go to the lobby</span>
          </Link>
        </div>
      </Theater>
    );
  }

  return (
    <Theater
      screen={
        <FocusText
          as="h1"
          className="theater__kicker"
          text={creatorName ? `${creatorName} saved you a seat` : 'Someone saved you a seat'}
          delay={0.35}
        />
      }
    >
      <div className="status-card" style={{ paddingTop: 12 }}>
        {/* Theirs is already lit; yours arrives when you press join. */}
        <m.div initial={{ scale: 0.7, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} transition={{ delay: 0.6 }}>
          <Lights together={isJoining} size={92} />
        </m.div>
        <h2>{creatorName ? `${creatorName} is waiting` : 'Someone is waiting'}</h2>
        <p>Joining takes you to a quick camera and mic check first. Nobody sees you until you’re ready.</p>

        {error && (
          <div ref={errorRef} className="notice notice--error" role="alert" style={{ width: '100%' }}>
            <AlertIcon size={18} />
            <span>{error}</span>
          </div>
        )}

        <div className="cluster" style={{ justifyContent: 'center', marginTop: 6 }}>
          <Link to="/" className="btn btn--ghost" data-light="">
            <span>Not now</span>
          </Link>
          <Button
            variant="primary"
            size="lg"
            magnetic
            icon={<PlayIcon size={20} />}
            onClick={handleJoin}
            loading={isJoining}
            disabled={isJoining}
          >
            {isJoining ? 'Joining…' : 'Join session'}
          </Button>
        </div>
      </div>
    </Theater>
  );
}
