import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { PASSWORD_MIN_LENGTH } from '@shared/password';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { PasswordField } from './PasswordField';
import { isPasswordValid } from '../../utils/password';
import {
  Sketchbook,
  SectionTitle,
  StickerButton,
  BurstSticker,
  BackButton,
  Doodle,
} from '../manga';

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
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <div className="hand" style={{ fontSize: 28, color: 'var(--purple)' }}>
            checking that link…
          </div>
        </div>
      </div>
    );
  }

  if (invalidMessage) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <Sketchbook style={{ width: '100%', maxWidth: 540 }}>
            <div style={{ textAlign: 'center' }}>
              <SectionTitle size={42} underline="orange">
                LINK NO GOOD
              </SectionTitle>
              <div style={{ marginTop: 30, display: 'flex', justifyContent: 'center' }}>
                <BurstSticker bg="var(--orange)" rot={-3} w={220} h={140}>
                  AW SHUCKS!
                </BurstSticker>
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 20, color: 'rgba(26,20,23,0.7)' }}>
                {invalidMessage}
              </p>
              <p className="hand" style={{ fontSize: 18, marginTop: 8, color: 'rgba(26,20,23,0.55)' }}>
                reset links expire after 48h and work exactly once. ask an admin for a fresh one.
              </p>
              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
                <Link to="/login" style={{ textDecoration: 'none' }}>
                  <BackButton>back to login</BackButton>
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
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 640 }}>
          <SectionTitle size={46} underline="purple">
            NEW PASSWORD
          </SectionTitle>

          <div className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}>
            for <span style={{ color: 'var(--purple)' }}>{tag ?? username}</span> — pick something
            you have not used anywhere else.
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 20, maxWidth: 520 }}>
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
              hint={`at least ${PASSWORD_MIN_LENGTH} characters — length beats punctuation`}
            />

            <PasswordField
              label="again:"
              value={confirm}
              onChange={(v) => {
                setConfirm(v);
                setError(null);
              }}
              autoComplete="new-password"
              disabled={isLoading}
              validate={false}
              hint={confirm && !passwordsMatch ? '· those two do not match' : ' '}
            />

            {error && (
              <div className="shake" style={{ marginTop: 18 }} role="alert">
                <BurstSticker bg="var(--orange)" rot={-4} w={180} h={120}>
                  OOPS!
                </BurstSticker>
                <div className="hand" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)' }}>
                  {error}
                </div>
              </div>
            )}

            <div className="row" style={{ gap: 18, marginTop: 28, flexWrap: 'wrap' }}>
              <StickerButton
                type="submit"
                color="purple"
                size="xl"
                sfx="POP!"
                disabled={isLoading || !canSubmit}
              >
                {isLoading ? 'SETTING…' : 'SET IT'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>never mind</BackButton>
              </Link>
            </div>
          </form>

          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="sparkle" size={40} color="var(--purple)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
