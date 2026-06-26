import { useState } from 'react';
import { useNavigate, useLocation, Link } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { TermsModal } from '../Auth/TermsModal';
import { PasswordField } from '../Auth/PasswordField';
import { GoogleSignInButton } from '../Auth/GoogleSignInButton';
import {
  Sketchbook,
  SectionTitle,
  TagSticker,
  NotebookField,
  StickerButton,
  Doodle,
  BurstSticker,
} from '../manga';

/**
 * Normalize backend auth errors before showing them. Goals:
 *
 *   - Don't echo backend-internal phrases the user can't act on.
 *   - Keep the message generic by default so we never leak whether an
 *     email is registered (the backend already runs constant-time so
 *     the answer is "you can't tell from any signal" — UI matches).
 *   - When the backend hints at lockout, surface a softer copy that
 *     points at password reset instead of just confusing the user.
 *
 * The match is intentionally substring-based: it's fine to add more
 * mappings as backend error shapes evolve.
 */
function normalizeLoginError(raw: string | null): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();
  if (lower.includes('lock') || lower.includes('too many')) {
    return 'Too many failed attempts. Try again in a few minutes or use password reset.';
  }
  if (lower.includes('verify') && lower.includes('email')) {
    return 'Please verify your email before signing in — check your inbox.';
  }
  // Default: keep it generic. Both "user not found" and "wrong password"
  // collapse into this single message — same as the backend, no leak.
  return 'Email or password is incorrect.';
}

export function Login() {
  const navigate = useNavigate();
  // Hand-off from /register/:token + /invite/:token success — those screens
  // navigate here with { state: { email, justRegistered: true } } so we can
  // prefill the address and pop a "kayıt başarılı" banner without forcing
  // the user to retype anything they just typed two seconds ago.
  const location = useLocation();
  const navState = (location.state ?? {}) as { email?: string; justRegistered?: boolean };

  const [email, setEmail] = useState(navState.email ?? '');
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const [showJustRegisteredBanner, setShowJustRegisteredBanner] = useState(!!navState.justRegistered);
  const { login, loginWithGoogle, loginWithPasskey, isLoading, error, updateTermsAccepted } = useAuthContext();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!email.trim() || !password) return;

    try {
      const user = await login(email.trim(), password, rememberMe);
      if (!user.hasAcceptedTerms) {
        setShowTermsModal(true);
      } else {
        navigate('/');
      }
    } catch {
      // Error is handled by context
    }
  };

  const handleTermsAccepted = () => {
    updateTermsAccepted();
    setShowTermsModal(false);
    navigate('/');
  };

  const handlePasskeySignIn = async () => {
    try {
      // Usernameless flow — passing email through if filled lets the
      // browser scope to that user's credentials; otherwise resident
      // (discoverable) credentials pick themselves.
      const user = await loginWithPasskey(email.trim() || undefined);
      if (!user.hasAcceptedTerms) {
        setShowTermsModal(true);
      } else {
        navigate('/');
      }
    } catch {
      // useAuth surfaces the error into context.error.
    }
  };

  const handleGoogleCredential = async (idToken: string) => {
    try {
      const user = await loginWithGoogle(idToken);
      if (!user.hasAcceptedTerms) {
        setShowTermsModal(true);
      } else {
        navigate('/');
      }
    } catch {
      // useAuth surfaces the error into context.error — same banner renders.
    }
  };

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 720 }}>
          {/* Title */}
          <div style={{ marginBottom: 24, position: 'relative' }}>
            <SectionTitle size={64} underline="pink">
              WatchTogether
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="purple" rot={6}>
                BETA
              </TagSticker>
            </div>
            <div
              className="hand"
              style={{ fontSize: 24, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}
            >
              two friends. one screen. ♥
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 480, position: 'relative' }}>
            <NotebookField
              label="email:"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@watchtogether.app"
              autoFocus
              disabled={isLoading}
            />

            <PasswordField
              label="password:"
              value={password}
              onChange={setPassword}
              placeholder="shhh — keep it secret"
              disabled={isLoading}
              showChecklist={false}
              showStrengthMeter={false}
            />

            {/* Remember me — handwritten checkbox */}
            <label
              className="hand"
              style={{
                display: 'inline-flex',
                alignItems: 'center',
                gap: 8,
                marginTop: 16,
                fontSize: 20,
                color: 'rgba(26,20,23,0.7)',
                cursor: 'pointer',
              }}
            >
              <input
                type="checkbox"
                checked={rememberMe}
                onChange={(e) => setRememberMe(e.target.checked)}
                disabled={isLoading}
                style={{
                  width: 18,
                  height: 18,
                  accentColor: 'var(--pink)',
                  cursor: 'pointer',
                }}
              />
              remember me on this notebook
            </label>

            {showJustRegisteredBanner && !error && (
              <div
                role="status"
                style={{
                  marginTop: 16,
                  padding: '12px 16px',
                  border: '3px solid var(--ink)',
                  background: 'rgba(123,63,228,0.12)',
                  boxShadow: '4px 4px 0 var(--purple)',
                  position: 'relative',
                }}
              >
                <div className="hand" style={{ fontSize: 20, color: 'var(--ink)' }}>
                  <Doodle kind="sparkle" size={18} color="var(--purple)" /> hesabın hazır! şifrenle giriş yap ↓
                </div>
                <button
                  type="button"
                  onClick={() => setShowJustRegisteredBanner(false)}
                  aria-label="dismiss"
                  style={{
                    position: 'absolute',
                    top: 4,
                    right: 8,
                    background: 'transparent',
                    border: 'none',
                    cursor: 'pointer',
                    fontSize: 18,
                    color: 'var(--ink)',
                  }}
                >
                  ×
                </button>
              </div>
            )}

            {error && (
              <div className="shake" style={{ marginTop: 16, textAlign: 'left' }} role="alert">
                <BurstSticker bg="var(--orange)" rot={-4} w={170} h={110}>
                  OOPS!
                </BurstSticker>
                <div className="hand" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)' }}>
                  {normalizeLoginError(error)}
                </div>
              </div>
            )}

            <div
              className="row"
              style={{ gap: 18, marginTop: 28, flexWrap: 'wrap', alignItems: 'center' }}
            >
              <StickerButton
                type="submit"
                color="pink"
                size="xl"
                sfx="TAP!"
                sparks
                breathe
                disabled={isLoading || !email.trim() || !password}
              >
                {isLoading ? 'SIGNING IN…' : 'SIGN IN'}
              </StickerButton>
            </div>

            <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)', marginTop: 14 }}>
              psst — without remember-me you'll be signed out when this tab closes
            </div>

            {/* Google sign-in alternative. The button hides itself when
                VITE_GOOGLE_CLIENT_ID is missing (local-dev without the
                env var), so this whole block becomes invisible — no
                stranded "or" divider. */}
            <div
              style={{
                marginTop: 22,
                display: 'flex',
                flexDirection: 'column',
                alignItems: 'flex-start',
                gap: 12,
              }}
            >
              <div
                className="hand"
                style={{
                  fontSize: 18,
                  color: 'rgba(26,20,23,0.5)',
                  letterSpacing: 1,
                }}
              >
                — or —
              </div>
              <GoogleSignInButton onCredential={handleGoogleCredential} />

              {/* Passkey button. Renders unconditionally — feature-detect
                  happens inside startAuthentication. Old browsers without
                  WebAuthn support get a clean error toast via context.error. */}
              <button
                type="button"
                onClick={handlePasskeySignIn}
                disabled={isLoading}
                aria-label="Sign in with a passkey"
                style={{
                  display: 'inline-flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '10px 16px',
                  background: 'var(--cream)',
                  color: 'var(--ink)',
                  border: '3px solid var(--ink)',
                  borderRadius: 4,
                  boxShadow: '3px 3px 0 var(--ink)',
                  fontFamily: 'var(--font-body)',
                  fontWeight: 700,
                  fontSize: 14,
                  cursor: isLoading ? 'not-allowed' : 'pointer',
                  opacity: isLoading ? 0.5 : 1,
                  transform: 'rotate(-0.5deg)',
                  transition: 'transform 150ms ease, box-shadow 150ms ease',
                }}
                onMouseEnter={(e) => {
                  if (isLoading) return;
                  e.currentTarget.style.transform = 'rotate(0) translateY(-2px)';
                  e.currentTarget.style.boxShadow = '5px 5px 0 var(--ink)';
                }}
                onMouseLeave={(e) => {
                  e.currentTarget.style.transform = 'rotate(-0.5deg) translateY(0)';
                  e.currentTarget.style.boxShadow = '3px 3px 0 var(--ink)';
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path
                    d="M12 1a4 4 0 014 4v3h1a3 3 0 013 3v9a3 3 0 01-3 3H7a3 3 0 01-3-3v-9a3 3 0 013-3h1V5a4 4 0 014-4zm0 2a2 2 0 00-2 2v3h4V5a2 2 0 00-2-2zm0 11a2 2 0 100 4 2 2 0 000-4z"
                    fill="currentColor"
                  />
                </svg>
                Sign in with a passkey
              </button>
            </div>
          </form>

          {/* Guest CTA — for people who don't have an invite yet. Visually
              detached from the form (own bordered card + breathing button)
              so it reads as "different track entirely", not another sign-in
              method. Purple to distinguish from the pink sign-in primary. */}
          <div
            style={{
              marginTop: 36,
              padding: '20px 22px',
              border: '3px solid var(--ink)',
              background: 'rgba(123,63,228,0.08)',
              boxShadow: '5px 5px 0 var(--purple)',
              transform: 'rotate(-0.4deg)',
              maxWidth: 520,
              position: 'relative',
            }}
          >
            <div
              className="hand"
              style={{ fontSize: 22, color: 'var(--ink)', marginBottom: 12 }}
            >
              don't have an invite yet?
            </div>
            <div
              className="hand"
              style={{ fontSize: 18, color: 'rgba(26,20,23,0.65)', marginBottom: 16 }}
            >
              tell us a bit about yourself and we'll send one over.
            </div>
            <Link to="/request-demo" style={{ textDecoration: 'none' }}>
              <StickerButton color="purple" size="xl" sfx="POP!" breathe>
                GUEST? REQUEST DEMO
              </StickerButton>
            </Link>
          </div>

          {/* Margin doodles */}
          <div className="margin-doodles" style={{ position: 'absolute', right: 24, top: 40 }}>
            <span className="bob" style={{ ['--r' as string]: '-12deg', ['--r2' as string]: '8deg', display: 'inline-block' } as React.CSSProperties}>
              <Doodle kind="tv" size={56} color="var(--purple)" />
            </span>
          </div>
          <div className="margin-doodles" style={{ position: 'absolute', right: 80, top: 140 }}>
            <span className="bob delay-1" style={{ ['--r' as string]: '10deg', ['--r2' as string]: '-6deg', display: 'inline-block' } as React.CSSProperties}>
              <Doodle kind="popcorn" size={48} color="var(--orange)" />
            </span>
          </div>
          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 180 }}>
            <span className="bob delay-2" style={{ ['--r' as string]: '-6deg', ['--r2' as string]: '10deg', display: 'inline-block' } as React.CSSProperties}>
              <Doodle kind="heart" size={42} color="var(--pink)" />
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
