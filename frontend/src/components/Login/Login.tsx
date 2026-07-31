import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { TermsModal } from '../Auth/TermsModal';
import { PasskeyIcon } from '../Auth/PasskeyIcon';
import { UsernameField } from '../Auth/UsernameField';
import {
  Sketchbook,
  SectionTitle,
  TagSticker,
  StickerButton,
  Doodle,
  BurstSticker,
} from '../manga';

/**
 * Sign-in, passkey-only.
 *
 * There is nothing to type. The authenticator holds a discoverable credential
 * for this site and the server identifies you from it, so the screen is one
 * button — no email, no password, no "forgot" flow, and no account-enumeration
 * surface, because nothing is ever submitted to be looked up.
 *
 * The one exception is first run: with no email and no password, the very first
 * account cannot be invited by anybody, so an empty database plus a deployment
 * secret is the only way to mint root.
 */
export function Login() {
  const navigate = useNavigate();
  const { loginWithPasskey, setupRootWithPasskey, isLoading, error, setError, updateTermsAccepted } =
    useAuthContext();

  const [showTermsModal, setShowTermsModal] = useState(false);
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

  const land = (hasAcceptedTerms?: boolean) => {
    if (hasAcceptedTerms) navigate('/');
    else setShowTermsModal(true);
  };

  const handleSignIn = async () => {
    try {
      land((await loginWithPasskey()).hasAcceptedTerms);
    } catch {
      // useAuth has already turned this into a readable message.
    }
  };

  const handleSetup = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      land((await setupRootWithPasskey(setupUsername.trim(), setupSecret)).hasAcceptedTerms);
    } catch {
      // Same.
    }
  };

  const handleTermsAccepted = () => {
    updateTermsAccepted();
    setShowTermsModal(false);
    navigate('/');
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
          </div>

          {/* No sign-up link on purpose: accounts exist only by invitation, so
              a "create account" affordance would lead nowhere for everybody who
              does not already hold a link. Invitees arrive at /invite/:token. */}
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

      <TermsModal isOpen={showTermsModal} onAccept={handleTermsAccepted} />
    </div>
  );
}
