import { useCallback, useEffect, useRef, useState } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { PASSWORD_MIN_LENGTH } from '@shared/password';
import { UsernameField } from './UsernameField';
import { PasswordField } from './PasswordField';
import { isUsernameValid } from '../../utils/username';
import { isPasswordValid } from '../../utils/password';
import { Theater } from '../ui/Theater';
import { FocusText } from '../ui/FocusText';
import { Button } from '../ui/Button';
import { Segmented } from '../ui/Segmented';
import { AlertIcon, LockIcon, PasskeyIcon, TicketIcon } from '../ui/icons';
import { shake } from '../ui/interactions';
import { ease } from '../ui/motion';

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
  const errorRef = useRef<HTMLDivElement>(null);

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

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

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
      <Theater screen={<p className="theater__kicker">Checking your invite…</p>}>
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
      <Theater screen={<FocusText as="h1" className="theater__kicker" text="No seat on this ticket" />}>
        <div className="status-card">
          <span className="status-card__icon" aria-hidden="true">
            <TicketIcon size={28} />
          </span>
          <h2>This invite can’t be used</h2>
          <p>{invalidMessage}</p>
          <p className="muted">
            Invite links expire after 48 hours and work exactly once. Ask your friend for a fresh one.
          </p>
          <Link to="/login" className="btn btn--secondary" data-light="">
            <span>Back to sign in</span>
          </Link>
        </div>
      </Theater>
    );
  }

  const createLabel = method === 'password' ? 'Create account' : 'Create account with a passkey';

  return (
    <Theater
      screen={
        <>
          <FocusText
            as="h1"
            className="theater__kicker"
            text={inviterTag ? `${inviterTag} saved you a seat` : 'You have a seat'}
            delay={0.4}
          />
          <m.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 1, duration: 0.7 }}>
            Pick a name and how you’ll sign in.
          </m.p>
        </>
      }
      foot={
        <p>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="stack" style={{ ['--gap' as string]: '20px' }}>
        <UsernameField
          value={username}
          onChange={(v) => {
            setUsername(v);
            setError(null);
          }}
          disabled={isLoading}
          autoFocus
        />

        <div className="stack" style={{ ['--gap' as string]: '10px' }}>
          <span className="field__label" id="method-label">
            How you’ll sign in
          </span>
          <Segmented
            legend="How you’ll sign in"
            name="signin-method"
            value={method}
            disabled={isLoading}
            onChange={(next) => {
              setMethod(next);
              setError(null);
            }}
            options={[
              { value: 'passkey', label: 'Passkey', icon: <PasskeyIcon size={18} /> },
              { value: 'password', label: 'Password', icon: <LockIcon size={18} /> },
            ]}
          />
        </div>

        <AnimatePresence mode="wait" initial={false}>
          {method === 'passkey' ? (
            <m.p
              key="passkey"
              className="method-note"
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.25, ease: ease.out }}
            >
              <PasskeyIcon size={18} />
              <span>Next, your device asks for your face, fingerprint or PIN. That’s the whole password.</span>
            </m.p>
          ) : (
            <m.div
              key="password"
              className="stack"
              style={{ ['--gap' as string]: '16px' }}
              initial={{ opacity: 0, y: 8 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -6 }}
              transition={{ duration: 0.3, ease: ease.out }}
            >
              <PasswordField
                value={password}
                onChange={(v) => {
                  setPassword(v);
                  setError(null);
                }}
                username={username}
                autoComplete="new-password"
                disabled={isLoading}
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
                // The rules are already being graded on the field above;
                // repeating them under this one would just be shouting twice.
                validate={false}
                hint={confirm && !passwordsMatch ? 'Those two don’t match yet.' : ' '}
              />

              {/* Said plainly, because it is the one thing about this choice
                  that cannot be undone later by the person making it. */}
              <div className="notice notice--warn">
                <AlertIcon size={18} />
                <span>
                  <strong>There’s no password reset here.</strong> No email address is ever collected, so if you
                  forget it, an admin has to issue you a new link by hand.
                </span>
              </div>
            </m.div>
          )}
        </AnimatePresence>

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
          icon={method === 'passkey' ? <PasskeyIcon size={20} /> : undefined}
        >
          {isLoading ? 'Creating…' : createLabel}
        </Button>
      </form>
    </Theater>
  );
}
