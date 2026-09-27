import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { m } from 'motion/react';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { UsernameField } from '../Auth/UsernameField';
import { PasswordField } from '../Auth/PasswordField';
import { isTagValid } from '../../utils/password';
import { Theater } from '../ui/Theater';
import { FocusText } from '../ui/FocusText';
import { Button } from '../ui/Button';
import { TextField } from '../ui/Field';
import { AlertIcon, PasskeyIcon, SparkIcon } from '../ui/icons';
import { shake } from '../ui/interactions';
import { ease } from '../ui/motion';

/**
 * Sign-in. Passkey first, password underneath.
 *
 * The passkey button stays the headline and stays at the top: it needs no
 * handle typed, it cannot be phished, and it is still what a new invitee is
 * steered toward. What changed is that it is no longer compulsory — a device
 * that cannot make passkeys, or a person who would rather not, has a way in.
 *
 * The password half costs something honest and worth naming here: it needs the
 * full `name#1234` handle, because a bare username is ambiguous; and it gives
 * the app an account-enumeration surface the passkey-only design did not have,
 * which is why the server answers "no such handle" and "wrong password" with
 * one identical sentence, after doing identical work. There is also no
 * recovery link, because there is no email address to send anything to —
 * recovery is a link root issues by hand.
 *
 * First run is unchanged and still passkey-only: claiming root is a one-time
 * action at a keyboard, gated on an empty database plus a deployment secret.
 *
 * The third thing this screen offers is not a way in at all: "request a demo"
 * files a note for root, who answers with an invite link by hand. It is the
 * only affordance here for a visitor who has neither an account nor a friend
 * holding a link, and it deliberately looks like the footnote it is.
 */
export function Login() {
  const navigate = useNavigate();
  const {
    loginWithPasskey,
    loginWithPassword,
    setupRootWithPasskey,
    isLoading,
    error,
    setError,
  } = useAuthContext();

  const [tag, setTag] = useState('');
  const [tagTouched, setTagTouched] = useState(false);
  const [password, setPassword] = useState('');
  // Which button started the work, so only that one shows it is busy.
  const [pending, setPending] = useState<'passkey' | 'password' | 'setup' | null>(null);

  // undefined while unknown — the setup panel must not flash on a normal load.
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | undefined>(undefined);
  const [setupUsername, setSetupUsername] = useState('');
  const [setupSecret, setSetupSecret] = useState('');

  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    api
      .setupStatus()
      .then((s) => setIsSetupComplete(s.isSetupComplete))
      // Assume set up: showing the bootstrap form because a health check
      // blipped would be worse than hiding it from the one person who needs it.
      .catch(() => setIsSetupComplete(true));
  }, []);

  // A fresh failure shakes its message, so a second wrong password is
  // visibly a new answer and not the old one still sitting there.
  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

  // Always land on the lobby. Whether the House Rules still need accepting is
  // TermsGate's business now (see App.tsx) — it renders over whatever route the
  // user ends up on, so this screen no longer has to know.
  const handleSignIn = async () => {
    setPending('passkey');
    try {
      await loginWithPasskey();
      navigate('/');
    } catch {
      // useAuth has already turned this into a readable message.
    } finally {
      setPending(null);
    }
  };

  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending('password');
    try {
      await loginWithPassword(tag, password);
      navigate('/');
    } catch {
      // Same — the server's own sentence is already on screen.
    } finally {
      setPending(null);
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    setPending('setup');
    try {
      await setupRootWithPasskey(setupUsername.trim(), setupSecret);
      navigate('/');
    } catch {
      // Same.
    } finally {
      setPending(null);
    }
  };

  // Only after the field is left: mid-typing "alic" is not a mistake yet.
  const tagProblem =
    tagTouched && tag.trim() && !tag.includes('#') ? 'Add the number after the #, like alice#0042.' : null;

  return (
    <Theater
      screen={
        <>
          <FocusText as="h1" text="WatchTogether" delay={0.45} stagger={0.1} />
          <m.p
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: ease.out, delay: 0.95 }}
          >
            Two people, one screen.
          </m.p>
        </>
      }
      foot={
        <>
          <p>
            No account yet? WatchTogether is invite-only, so ask the friend who told you about it for a link.
          </p>
          <p>
            Nobody to ask? <Link to="/request-demo">Request a demo</Link>
          </p>
        </>
      }
    >
      {error && (
        <div ref={errorRef} className="notice notice--error" role="alert">
          <AlertIcon size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className="stack" style={{ ['--gap' as string]: '12px' }}>
        <Button
          variant="primary"
          size="lg"
          block
          magnetic
          icon={<PasskeyIcon size={20} />}
          loading={pending === 'passkey'}
          disabled={isLoading}
          onClick={handleSignIn}
        >
          {pending === 'passkey' ? 'Waiting for your device…' : 'Sign in with a passkey'}
        </Button>
        <p className="passkey-hint">Uses your face, fingerprint or device PIN. Nothing to remember.</p>
      </div>

      {/* The password form is deliberately under the passkey button rather than
          beside it — both work, but only one of them is the recommendation. */}
      <div className="divider">or</div>

      <form onSubmit={handlePasswordSignIn} className="stack" style={{ ['--gap' as string]: '14px' }}>
        <TextField
          label="Handle"
          value={tag}
          onValueChange={(v) => {
            setTag(v);
            setError(null);
          }}
          placeholder="alice#0042"
          disabled={isLoading}
          autoComplete="username"
          // Spellcheck and autocapitalise both mangle a handle on mobile.
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          onBlur={() => setTagTouched(true)}
          problem={tagProblem}
          hint="Your full handle, number included."
        />

        <PasswordField
          value={password}
          onChange={(v) => {
            setPassword(v);
            setError(null);
          }}
          autoComplete="current-password"
          disabled={isLoading}
          // No rulebook on the way in: the password is either the one on
          // file or it is not, and grading it here would only insult
          // somebody whose account predates the current rules.
          validate={false}
        />

        <Button
          type="submit"
          variant="secondary"
          block
          loading={pending === 'password'}
          // Gated on the handle parsing, so "you need the number too" is
          // visible in the button rather than arriving as a 400.
          disabled={isLoading || !isTagValid(tag) || !password}
        >
          {pending === 'password' ? 'Checking…' : 'Sign in with a password'}
        </Button>
      </form>

      {/* First run only. Disappears permanently the moment root exists. */}
      {isSetupComplete === false && (
        <form onSubmit={handleSetup} className="setup-panel">
          <div className="setup-panel__title">
            <SparkIcon size={20} />
            <span>First run: claim this instance</span>
          </div>
          <p className="muted" style={{ fontSize: '0.95rem' }}>
            Nobody has registered yet. The setup secret is the one set with{' '}
            <code>wrangler secret put SETUP_SECRET</code>.
          </p>

          <UsernameField
            value={setupUsername}
            onChange={(v) => {
              setSetupUsername(v);
              setError(null);
            }}
            disabled={isLoading}
          />

          <TextField
            label="Setup secret"
            type="password"
            value={setupSecret}
            onValueChange={setSetupSecret}
            disabled={isLoading}
            autoComplete="off"
          />

          <Button
            type="submit"
            variant="primary"
            block
            icon={<PasskeyIcon size={18} />}
            loading={pending === 'setup'}
            disabled={isLoading || !setupUsername.trim() || !setupSecret}
          >
            {pending === 'setup' ? 'Claiming…' : 'Create root account'}
          </Button>
        </form>
      )}
    </Theater>
  );
}
