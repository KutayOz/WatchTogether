import { useCallback, useEffect, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { PASSWORD_MIN_LENGTH } from '@shared/password';
import { PasskeyIcon } from './PasskeyIcon';
import { UsernameField } from './UsernameField';
import { PasswordField } from './PasswordField';
import { isUsernameValid } from '../../utils/username';
import { isPasswordValid } from '../../utils/password';
import {
  Sketchbook,
  SectionTitle,
  TagSticker,
  StickerButton,
  BurstSticker,
  BackButton,
  Doodle,
} from '../manga';

/**
 * Account creation from an invite link.
 *
 * Pick a name, pick how you want to sign in, you're in — no email and no
 * verification round-trip either way. The old flow asked for an address, a
 * display name and two matching passwords, then bounced through an inbox.
 *
 * A passkey is preselected because it is the better credential and because it
 * is the one with a story if it is lost. A password here has no self-service
 * recovery at all — there is no address to mail a link to — so the choice is
 * presented with that said out loud rather than buried.
 *
 * Registering signs you in directly: the server issues the session cookie from
 * the same response that creates the account, so there is no second sign-in
 * step to lose people at.
 */
type Method = 'passkey' | 'password';

export function InviteSignup() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const { registerWithPasskey, registerWithPassword, isLoading, error, setError } =
    useAuthContext();

  const [username, setUsername] = useState('');
  const [method, setMethod] = useState<Method>('passkey');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [isValidating, setIsValidating] = useState(true);
  const [inviterTag, setInviterTag] = useState<string | null>(null);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);

  const passwordsMatch = password.length > 0 && password === confirm;
  const canSubmit =
    isUsernameValid(username) &&
    (method === 'passkey' || (isPasswordValid(password, username) && passwordsMatch));

  const validateInviteLink = useCallback(async () => {
    if (!token) {
      setInvalidMessage('That invite is not valid.');
      setIsValidating(false);
      return;
    }
    try {
      const result = await api.validateInviteLink(token);
      if (result.valid) setInviterTag(result.inviterTag ?? null);
      else setInvalidMessage(result.message ?? 'That invite is not valid.');
    } catch {
      setInvalidMessage('Could not check that invite link.');
    } finally {
      setIsValidating(false);
    }
  }, [token]);

  useEffect(() => {
    validateInviteLink();
  }, [validateInviteLink]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!token || !canSubmit) return;

    try {
      if (method === 'password') await registerWithPassword(token, username.trim(), password);
      else await registerWithPasskey(token, username.trim());
      // Off the one-time invite URL either way: a brand-new account has never
      // accepted the House Rules, so TermsGate (see App.tsx) will render over
      // the lobby, and re-rendering this screen behind it would only re-check
      // an invite that has already been spent.
      navigate('/');
    } catch {
      // useAuth has already turned this into a readable message.
    }
  };

  if (isValidating) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <div className="hand" style={{ fontSize: 28, color: 'var(--purple)' }}>
            checking invitation link…
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
                LINK EXPIRED
              </SectionTitle>
              <div style={{ marginTop: 30, display: 'flex', justifyContent: 'center' }}>
                <BurstSticker bg="var(--orange)" rot={-3} w={220} h={140}>
                  AW SHUCKS!
                </BurstSticker>
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 20, color: 'rgba(26,20,23,0.7)' }}>
                {invalidMessage}
              </p>
              <p
                className="hand"
                style={{ fontSize: 18, marginTop: 8, color: 'rgba(26,20,23,0.55)' }}
              >
                links expire after 48h, and each one works exactly once. ask your friend for a
                fresh one.
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
        <Sketchbook style={{ width: '100%', maxWidth: 720 }}>
          <div style={{ marginBottom: 12, position: 'relative' }}>
            <SectionTitle size={52} underline="pink">
              JOIN THE PARTY
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="orange" rot={6}>
                INVITED
              </TagSticker>
            </div>
            {inviterTag && (
              <div
                className="hand"
                style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}
              >
                <span style={{ color: 'var(--purple)' }}>{inviterTag}</span> wants to hang out with
                you ↓
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 520 }}>
            <UsernameField
              value={username}
              onChange={(v) => {
                setUsername(v);
                setError(null);
              }}
              disabled={isLoading}
              autoFocus
            />

            <fieldset style={{ border: 'none', padding: 0, margin: '26px 0 0' }}>
              <legend className="hand" style={{ fontSize: 22, color: 'var(--purple)' }}>
                how do you want to sign in?
              </legend>

              <div className="row" style={{ gap: 20, marginTop: 10, flexWrap: 'wrap' }}>
                {(['passkey', 'password'] as const).map((option) => (
                  <label
                    key={option}
                    className="hand"
                    style={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 8,
                      fontSize: 20,
                      cursor: isLoading ? 'default' : 'pointer',
                      color: method === option ? 'var(--ink)' : 'rgba(26,20,23,0.55)',
                    }}
                  >
                    <input
                      type="radio"
                      name="signin-method"
                      value={option}
                      checked={method === option}
                      disabled={isLoading}
                      onChange={() => {
                        setMethod(option);
                        setError(null);
                      }}
                    />
                    {option === 'passkey' ? 'a passkey' : 'a password'}
                  </label>
                ))}
              </div>
            </fieldset>

            {method === 'passkey' ? (
              <div
                className="hand"
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  marginTop: 20,
                  fontSize: 18,
                  color: 'rgba(26,20,23,0.6)',
                }}
              >
                <PasskeyIcon size={18} />
                next: your device will ask for your face, fingerprint or PIN
              </div>
            ) : (
              <div style={{ marginTop: 12 }}>
                <PasswordField
                  value={password}
                  onChange={(v) => {
                    setPassword(v);
                    setError(null);
                  }}
                  username={username}
                  autoComplete="new-password"
                  disabled={isLoading}
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
                  // The rules are already being graded on the field above;
                  // repeating them under this one would just be shouting twice.
                  validate={false}
                  hint={confirm && !passwordsMatch ? '· those two do not match' : ' '}
                />

                {/* Said plainly, because it is the one thing about this choice
                    that cannot be undone later by the person making it. */}
                <div
                  className="hand"
                  style={{
                    marginTop: 16,
                    padding: '12px 14px',
                    border: '2px dashed var(--orange)',
                    fontSize: 17,
                    color: 'rgba(26,20,23,0.75)',
                  }}
                >
                  there is no password reset here — no email address is ever collected. if you
                  forget it, an admin has to issue you a new link by hand.
                </div>
              </div>
            )}

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
                color="pink"
                size="xl"
                sfx="TAP!"
                sparks
                disabled={isLoading || !canSubmit}
              >
                {isLoading
                  ? 'CREATING…'
                  : method === 'password'
                    ? 'CREATE MY ACCOUNT'
                    : 'CREATE MY PASSKEY'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>have an account?</BackButton>
              </Link>
            </div>
          </form>

          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="heart" size={40} color="var(--pink)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
