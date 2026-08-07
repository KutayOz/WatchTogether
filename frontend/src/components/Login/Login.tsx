import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { PasskeyIcon } from '../Auth/PasskeyIcon';
import { UsernameField } from '../Auth/UsernameField';
import { PasswordField } from '../Auth/PasswordField';
import { isTagValid } from '../../utils/password';
import {
  Sketchbook,
  SectionTitle,
  TagSticker,
  StickerButton,
  NotebookField,
  Doodle,
  BurstSticker,
} from '../manga';

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
 * one identical sentence, after doing identical work. There is also no "forgot"
 * link, because there is no email address to send anything to — recovery is a
 * link root issues by hand.
 *
 * First run is unchanged and still passkey-only: claiming root is a one-time
 * action at a keyboard, gated on an empty database plus a deployment secret.
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
  const [password, setPassword] = useState('');

  // undefined while unknown — the setup panel must not flash on a normal load.
  const [isSetupComplete, setIsSetupComplete] = useState<boolean | undefined>(undefined);
  const [setupUsername, setSetupUsername] = useState('');
  const [setupSecret, setSetupSecret] = useState('');

  useEffect(() => {
    api
      .setupStatus()
      .then((s) => setIsSetupComplete(s.isSetupComplete))
      // Assume set up: showing the bootstrap form because a health check
      // blipped would be worse than hiding it from the one person who needs it.
      .catch(() => setIsSetupComplete(true));
  }, []);

  // Always land on the lobby. Whether the House Rules still need accepting is
  // TermsGate's business now (see App.tsx) — it renders over whatever route the
  // user ends up on, so this screen no longer has to know.
  const handleSignIn = async () => {
    try {
      await loginWithPasskey();
      navigate('/');
    } catch {
      // useAuth has already turned this into a readable message.
    }
  };

  const handlePasswordSignIn = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await loginWithPassword(tag, password);
      navigate('/');
    } catch {
      // Same — the server's own sentence is already on screen.
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await setupRootWithPasskey(setupUsername.trim(), setupSecret);
      navigate('/');
    } catch {
      // Same.
    }
  };

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 720 }}>
          <div style={{ marginBottom: 24, position: 'relative' }}>
            <SectionTitle size={64} underline="pink">
              WatchTogether
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="purple" rot={6}>
                BETA
              </TagSticker>
            </div>
            <div className="hand" style={{ fontSize: 24, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}>
              two friends. one screen. ♥
            </div>
          </div>

          {error && (
            <div className="shake" style={{ marginTop: 8, textAlign: 'left' }} role="alert">
              <BurstSticker bg="var(--orange)" rot={-4} w={170} h={110}>
                OOPS!
              </BurstSticker>
              <div className="hand" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)' }}>
                {error}
              </div>
            </div>
          )}

          <div style={{ marginTop: 28, maxWidth: 520 }}>
            <StickerButton
              color="pink"
              size="xl"
              sfx="TAP!"
              sparks
              breathe
              disabled={isLoading}
              onClick={handleSignIn}
            >
              {isLoading ? 'CHECKING…' : 'SIGN IN WITH A PASSKEY'}
            </StickerButton>

            <div
              className="hand"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                fontSize: 18,
                color: 'rgba(26,20,23,0.55)',
                marginTop: 18,
              }}
            >
              <PasskeyIcon size={18} />
              your face, fingerprint or device PIN — nothing to remember
            </div>

            {/* Hand-drawn divider. The password form is deliberately below the
                fold of the passkey button rather than beside it — both work,
                but only one of them is the recommendation. */}
            <div
              className="hand"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 12,
                marginTop: 30,
                fontSize: 20,
                color: 'rgba(26,20,23,0.45)',
              }}
            >
              <span style={{ flex: 1, borderTop: '2px dashed rgba(26,20,23,0.25)' }} />
              or
              <span style={{ flex: 1, borderTop: '2px dashed rgba(26,20,23,0.25)' }} />
            </div>

            <form onSubmit={handlePasswordSignIn} style={{ marginTop: 8 }}>
              <NotebookField
                label="handle:"
                value={tag}
                onChange={(v) => {
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
                hint="the whole handle, number and all"
              />

              <div style={{ marginTop: 18 }}>
                <StickerButton
                  type="submit"
                  color="purple"
                  size="md"
                  sfx="POP!"
                  // Gated on the handle parsing, so "you need the number too"
                  // is visible in the button rather than arriving as a 400.
                  disabled={isLoading || !isTagValid(tag) || !password}
                >
                  {isLoading ? 'UNLOCKING…' : 'SIGN IN WITH A PASSWORD'}
                </StickerButton>
              </div>
            </form>
          </div>

          {/* No sign-up link, and no "forgot password" link, both on purpose.
              Accounts exist only by invitation, so a "create account"
              affordance would lead nowhere for anybody without a link; and
              there is no email address on file, so the only way back from a
              forgotten password is a link root issues by hand. */}
          <div
            style={{
              marginTop: 36,
              padding: '20px 22px',
              border: '3px solid var(--ink)',
              background: 'rgba(123,63,228,0.08)',
              boxShadow: '5px 5px 0 var(--purple)',
              transform: 'rotate(-0.4deg)',
              maxWidth: 520,
            }}
          >
            <div className="hand" style={{ fontSize: 22, color: 'var(--ink)', marginBottom: 8 }}>
              no account yet?
            </div>
            <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.65)' }}>
              WatchTogether is invite-only. ask the friend who told you about it for a link.
            </div>
          </div>

          {/* First run only. Disappears permanently the moment root exists. */}
          {isSetupComplete === false && (
            <form
              onSubmit={handleSetup}
              style={{
                marginTop: 28,
                padding: '20px 22px',
                border: '3px dashed var(--ink)',
                maxWidth: 520,
              }}
            >
              <div className="hand" style={{ fontSize: 22, color: 'var(--ink)', marginBottom: 4 }}>
                <Doodle kind="sparkle" size={18} color="var(--purple)" /> first run — claim this
                instance
              </div>
              <div
                className="hand"
                style={{ fontSize: 17, color: 'rgba(26,20,23,0.6)', marginBottom: 12 }}
              >
                nobody has registered yet. the setup secret is the one set with{' '}
                <code>wrangler secret put SETUP_SECRET</code>.
              </div>

              <UsernameField
                label="username:"
                value={setupUsername}
                onChange={(v) => {
                  setSetupUsername(v);
                  setError(null);
                }}
                disabled={isLoading}
              />

              <label className="hand" style={{ display: 'block', marginTop: 14, fontSize: 20 }}>
                setup secret:
                <input
                  type="password"
                  value={setupSecret}
                  onChange={(e) => setSetupSecret(e.target.value)}
                  disabled={isLoading}
                  autoComplete="off"
                  style={{
                    display: 'block',
                    width: '100%',
                    marginTop: 6,
                    padding: '10px 12px',
                    border: '3px solid var(--ink)',
                    background: 'var(--cream)',
                    fontFamily: 'var(--font-body)',
                    fontSize: 16,
                  }}
                />
              </label>

              <div style={{ marginTop: 18 }}>
                <StickerButton
                  type="submit"
                  color="purple"
                  size="md"
                  sfx="POP!"
                  disabled={isLoading || !setupUsername.trim() || !setupSecret}
                >
                  {isLoading ? 'CLAIMING…' : 'CREATE ROOT ACCOUNT'}
                </StickerButton>
              </div>
            </form>
          )}

          <div className="margin-doodles" style={{ position: 'absolute', right: 24, top: 40 }}>
            <span
              className="bob"
              style={
                {
                  ['--r' as string]: '-12deg',
                  ['--r2' as string]: '8deg',
                  display: 'inline-block',
                } as React.CSSProperties
              }
            >
              <Doodle kind="tv" size={56} color="var(--purple)" />
            </span>
          </div>
          <div className="margin-doodles" style={{ position: 'absolute', right: 80, top: 140 }}>
            <span
              className="bob delay-1"
              style={
                {
                  ['--r' as string]: '10deg',
                  ['--r2' as string]: '-6deg',
                  display: 'inline-block',
                } as React.CSSProperties
              }
            >
              <Doodle kind="popcorn" size={48} color="var(--orange)" />
            </span>
          </div>
          <div
            className="margin-doodles hand"
            style={{
              position: 'absolute',
              right: 48,
              bottom: 120,
              fontSize: 22,
              color: 'var(--purple)',
              transform: 'rotate(-6deg)',
            }}
          >
            watch with friends ♥
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
