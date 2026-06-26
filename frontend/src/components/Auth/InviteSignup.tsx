import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../../services/api';
import { useAuthContext } from '../../context/AuthContext';
import { evaluatePassword, validateEmail, type PasswordEvaluation } from '../../utils/validation';
import { PasswordField } from './PasswordField';
import { GoogleSignInButton } from './GoogleSignInButton';
import { TermsModal } from './TermsModal';
import {
  Sketchbook,
  SectionTitle,
  TagSticker,
  NotebookField,
  StickerButton,
  BurstSticker,
  BackButton,
  Doodle,
} from '../manga';

export function InviteSignup() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Separate state for the "email already in use" branch — when set, we render
  // a soft suggestion ("seems like you already have an account, sign in →")
  // instead of the generic red OOPS! sticker. The friend hit this either because
  // they registered before and forgot, or because a previous attempt partially
  // succeeded (user got created, link burn failed). Either way, the right next
  // step is /login with their email prefilled — not staring at a red error.
  const [existingAccountEmail, setExistingAccountEmail] = useState<string | null>(null);
  const [passwordEval, setPasswordEval] = useState<PasswordEvaluation>(() => evaluatePassword(''));
  const [emailError, setEmailError] = useState<string | null>(null);
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [isInvalid, setIsInvalid] = useState(false);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);
  const [showTermsModal, setShowTermsModal] = useState(false);
  const { loginWithGoogle, updateTermsAccepted } = useAuthContext();

  /**
   * Google sign-in from the invite-signup screen. The URL-bound invitation
   * token is passed through so the backend's invitation-gated new-user
   * path accepts the brand-new Google identity. Existing users (already
   * registered via password or a previous Google sign-in) ignore the token
   * server-side and just log in normally.
   */
  const handleGoogleCredential = async (idToken: string) => {
    try {
      const user = await loginWithGoogle(idToken, token);
      if (!user.hasAcceptedTerms) {
        setShowTermsModal(true);
      } else {
        navigate('/');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Google sign-in failed');
    }
  };

  const handleTermsAccepted = () => {
    updateTermsAccepted();
    setShowTermsModal(false);
    navigate('/');
  };

  useEffect(() => {
    if (token) {
      validateInviteLink();
    }

  }, [token]);

  const validateInviteLink = async () => {
    try {
      const result = await api.validateInviteLink(token!);
      if (result.valid) {
        setInviterName(result.inviterDisplayName || null);
      } else {
        setIsInvalid(true);
        setInvalidMessage(result.message || 'Invalid invitation link');
      }
    } catch {
      setIsInvalid(true);
      setInvalidMessage('Failed to validate invitation link');
    } finally {
      setIsLoading(false);
    }
  };

  const handleEmailChange = (value: string) => {
    setEmail(value);
    if (value && !validateEmail(value)) {
      setEmailError('that doesn\'t look like an email');
    } else {
      setEmailError(null);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setExistingAccountEmail(null);

    if (!email.trim() || !validateEmail(email)) {
      setError('Please enter a valid email address');
      return;
    }

    if (!displayName.trim()) {
      setError('Display name is required');
      return;
    }

    if (!passwordEval.valid) {
      setError('Please fix password requirements');
      return;
    }

    if (password !== confirmPassword) {
      setError('Passwords do not match');
      return;
    }

    setIsSubmitting(true);

    try {
      const result = await api.registerWithLink(token!, email, displayName, password);
      // Invite-based registration is now auto-verified server-side. No email
      // round-trip needed — drop the user on /login with their address
      // prefilled and a "kayıt başarılı" banner so they sign in in one click.
      navigate('/login', { state: { email: result.email, justRegistered: true } });
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Registration failed';
      // The backend returns "An account with this email already exists" (English)
      // for both legacy + link-based registration paths. Catch that family —
      // including the Turkish "zaten" wording in case a future i18n pass swaps
      // the strings — and surface the friendly "sign in instead" branch instead
      // of a generic red sticker. Falls back to setError for anything else.
      if (/already exists|zaten/i.test(msg)) {
        setExistingAccountEmail(email.trim());
      } else {
        setError(msg);
      }
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
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

  if (isInvalid) {
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
              <p className="hand" style={{ fontSize: 18, marginTop: 8, color: 'rgba(26,20,23,0.55)' }}>
                links expire after 48h. ask your friend for a fresh one.
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
            {inviterName && (
              <div className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}>
                <span style={{ color: 'var(--purple)' }}>{inviterName}</span> wants to hang out with you ↓
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 520 }}>
            <NotebookField
              label="email:"
              type="email"
              value={email}
              onChange={handleEmailChange}
              placeholder="you@somewhere.com"
              required
              autoFocus
            />
            {emailError && (
              <div className="hand" style={{ marginTop: 4, color: 'var(--orange-deep)', fontSize: 18 }}>
                {emailError}
              </div>
            )}

            <NotebookField
              label="your name:"
              value={displayName}
              onChange={setDisplayName}
              placeholder="what should we call you?"
              required
            />

            <PasswordField
              label="new password:"
              value={password}
              onChange={setPassword}
              placeholder="make it a good one"
              required
              onEvaluation={setPasswordEval}
            />

            <PasswordField
              label="again:"
              value={confirmPassword}
              onChange={setConfirmPassword}
              placeholder="type it once more"
              required
              showChecklist={false}
              showStrengthMeter={false}
            />
            {confirmPassword && password !== confirmPassword && (
              <div
                className="hand"
                aria-live="polite"
                style={{ marginTop: 4, color: 'var(--orange)', fontSize: 18 }}
              >
                · those two don't match yet
              </div>
            )}

            {existingAccountEmail && (
              <div
                style={{
                  marginTop: 18,
                  border: '3px solid var(--ink)',
                  background: 'rgba(123,63,228,0.06)',
                  padding: '14px 18px',
                  transform: 'rotate(0.3deg)',
                }}
              >
                <div className="hand" style={{ fontSize: 20, color: 'var(--ink)' }}>
                  Bu email <span style={{ color: 'var(--purple)' }}>{existingAccountEmail}</span> zaten kayıtlı.
                </div>
                <div className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.6)', marginTop: 4 }}>
                  Belki daha önce kayıt oldun — şifrenle giriş yapabilirsin.
                </div>
                <div style={{ marginTop: 12 }}>
                  <Link
                    to="/login"
                    // No justRegistered flag — this user already had the account, so the
                    // "hesabın hazır!" banner would be a lie. Email prefill only.
                    state={{ email: existingAccountEmail }}
                    style={{ textDecoration: 'none' }}
                  >
                    <StickerButton color="purple" size="md" sfx="TAP!">
                      GİRİŞ YAP →
                    </StickerButton>
                  </Link>
                </div>
              </div>
            )}

            {error && (
              <div className="shake" style={{ marginTop: 18 }}>
                <BurstSticker bg="var(--orange)" rot={-4} w={180} h={120}>
                  OOPS!
                </BurstSticker>
                <div className="hand" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)' }}>{error}</div>
              </div>
            )}

            <div className="row" style={{ gap: 18, marginTop: 28, flexWrap: 'wrap' }}>
              <StickerButton
                type="submit"
                color="pink"
                size="xl"
                sfx="TAP!"
                sparks
                disabled={
                  isSubmitting ||
                  !passwordEval.valid ||
                  !!emailError ||
                  !email.trim() ||
                  !displayName.trim() ||
                  password !== confirmPassword
                }
              >
                {isSubmitting ? 'CREATING…' : 'JOIN!'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>have an account?</BackButton>
              </Link>
            </div>

            {/* Google sign-up alternative. The button auto-hides when
                VITE_GOOGLE_CLIENT_ID isn't configured (dev without Google
                creds), so the divider doesn't strand if Google is off. We
                forward the URL's invitation token to loginWithGoogle so the
                backend's invitation-gated new-user path accepts the brand
                new Google identity. */}
            <div className="hand" style={{ textAlign: 'center', marginTop: 22, fontSize: 18, color: 'rgba(26,20,23,0.5)' }}>
              — or —
            </div>
            <div style={{ display: 'flex', justifyContent: 'center', marginTop: 14 }}>
              <GoogleSignInButton onCredential={handleGoogleCredential} />
            </div>
          </form>

          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="heart" size={40} color="var(--pink)" />
            </span>
          </div>
        </Sketchbook>
      </div>

      {/* Terms gate — fires when a brand-new Google account lands here:
          the backend created them with acceptedTermsAt=null so the response
          carries hasAcceptedTerms=false. updateTermsAccepted() flips the
          cached state and the user proceeds to the lobby. */}
      <TermsModal isOpen={showTermsModal} onAccept={handleTermsAccepted} />
    </div>
  );
}
