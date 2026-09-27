import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@shared/password';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { PasswordField } from './PasswordField';
import { isPasswordValid } from '../../utils/password';
import { Theater } from '../ui/Theater';
import { FocusText } from '../ui/FocusText';
import { Button } from '../ui/Button';
import { AlertIcon, LockIcon } from '../ui/icons';
import { shake } from '../ui/interactions';

/**
 * Redeem a root-issued password reset link.
 *
 * The whole of account recovery. No email address exists anywhere in this
 * system, so there is nothing to send a link *to* — root mints one from the
 * admin screen and hands it over out of band, and this is what it opens.
 *
 * It doubles as "add a password": redeeming a link on an account that never had
 * one simply gives it one. That is currently the only way an existing
 * passkey-only user can get a password at all, since Settings has no password
 * card yet.
 *
 * The username has to come from the server's probe rather than from anything
 * typed here, because it is the client-side salt. Deriving against a guessed
 * username would not fail loudly — it would store a key that nothing can
 * reproduce at sign-in.
 */
export function PasswordReset() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const { completePasswordReset, isLoading, error, setError } = useAuthContext();

  const [isChecking, setIsChecking] = useState(true);
  const [username, setUsername] = useState<string | null>(null);
  const [tag, setTag] = useState<string | null>(null);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);

  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const errorRef = useRef<HTMLDivElement>(null);

  const passwordsMatch = password.length > 0 && password === confirm;
  const canSubmit = isPasswordValid(password, username ?? undefined) && passwordsMatch;

  const checkLink = useCallback(async () => {
    if (!token) {
      setInvalidMessage('That reset link is not valid.');
      setIsChecking(false);
      return;
    }
    try {
      const result = await api.passwordResetStatus(token);
      if (result.valid && result.username) {
        setUsername(result.username);
        setTag(result.tag ?? null);
      } else {
        setInvalidMessage(
          result.reason === 'used'
            ? 'That reset link has already been used.'
            : result.reason === 'expired'
              ? 'That reset link has expired.'
              : 'That reset link is not valid.',
        );
      }
    } catch {
      setInvalidMessage('Could not check that reset link.');
    } finally {
      setIsChecking(false);
    }
  }, [token]);

  useEffect(() => {
    checkLink();
  }, [checkLink]);

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !username || !canSubmit) return;

    try {
      await completePasswordReset(token, username, password);
      // Redeeming signs you in, so there is no sign-in step to send them to.
      navigate('/');
    } catch {
      // useAuth has already put the server's own message on screen.
    }
  };

  if (isChecking) {
    return (
      <Theater screen={<p className="theater__kicker">Checking that link…</p>}>
        <div className="status-card">
          <span className="loading-line">
            <span className="btn__spinner" aria-hidden="true" />
            Checking the link
          </span>
        </div>
      </Theater>
    );
  }

  if (invalidMessage) {
    return (
      <Theater screen={<FocusText as="h1" className="theater__kicker" text="This link is spent" />}>
        <div className="status-card">
          <span className="status-card__icon" aria-hidden="true">
            <LockIcon size={28} />
          </span>
          <h2>This link can’t be used</h2>
          <p>{invalidMessage}</p>
          <p className="muted">Reset links expire after 48 hours and work exactly once. Ask an admin for a fresh one.</p>
          <Link to="/login" className="btn btn--secondary" data-light="">
            <span>Back to sign in</span>
          </Link>
        </div>
      </Theater>
    );
  }

  return (
    <Theater
      screen={<FocusText as="h1" className="theater__kicker" text="A new password" delay={0.35} />}
      foot={
        <p>
          Changed your mind? <Link to="/login">Back to sign in</Link>
        </p>
      }
    >
      <div className="stack" style={{ ['--gap' as string]: '6px' }}>
        <p className="muted">Setting a password for</p>
        <p style={{ fontSize: 'var(--t-xl)', fontWeight: 700, color: 'var(--amber-hi)' }}>{tag ?? username}</p>
        <p className="muted" style={{ fontSize: '0.95rem' }}>
          Pick something you haven’t used anywhere else.
        </p>
      </div>

      <form onSubmit={handleSubmit} className="stack" style={{ ['--gap' as string]: '16px' }}>
        <PasswordField
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          username={username ?? undefined}
          autoComplete="new-password"
          disabled={isLoading}
          autoFocus
          hint={`At least ${PASSWORD_MIN_LENGTH} characters. Length beats punctuation.`}
        />

        <PasswordField
          label="Repeat password"
          value={confirm}
          onChange={(v) => {
            setConfirm(v);
            setError(null);
          }}
          autoComplete="new-password"
          disabled={isLoading}
          validate={false}
          hint={confirm && !passwordsMatch ? 'Those two don’t match yet.' : ' '}
        />

        {error && (
          <div ref={errorRef} className="notice notice--error" role="alert">
            <AlertIcon size={18} />
            <span>{error}</span>
          </div>
        )}

        <Button
          type="submit"
          variant="primary"
          size="lg"
          block
          magnetic
          loading={isLoading}
          disabled={isLoading || !canSubmit}
        >
          {isLoading ? 'Setting…' : 'Set password'}
        </Button>
      </form>
    </Theater>
  );
}
