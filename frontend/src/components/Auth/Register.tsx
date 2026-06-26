import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../../services/api';
import { evaluatePassword, type PasswordEvaluation } from '../../utils/validation';
import { PasswordField } from './PasswordField';
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

export function Register() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [displayName, setDisplayName] = useState('');
  const [password, setPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [passwordEval, setPasswordEval] = useState<PasswordEvaluation>(() => evaluatePassword(''));
  const [inviterName, setInviterName] = useState<string | null>(null);
  const [isInvalid, setIsInvalid] = useState(false);
  const [invalidMessage, setInvalidMessage] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      validateInvitation();
    }

  }, [token]);

  const validateInvitation = async () => {
    try {
      const result = await api.validateInvitation(token!);
      if (result.isValid) {
        setInviterName(result.inviterName || null);
      } else {
        setIsInvalid(true);
        setInvalidMessage(result.message || 'Invalid invitation');
      }
    } catch {
      setIsInvalid(true);
      setInvalidMessage('Failed to validate invitation');
    } finally {
      setIsLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

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
      const result = await api.register(token!, displayName, password);
      // Invite-based registration is now auto-verified server-side. No email
      // round-trip needed — drop the user on /login with their address
      // prefilled and a "kayıt başarılı" banner so they sign in in one click.
      navigate('/login', { state: { email: result.email, justRegistered: true } });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Registration failed');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <div className="hand" style={{ fontSize: 28, color: 'var(--purple)' }}>
            validating invitation…
          </div>
        </div>
      </div>
    );
  }

  if (isInvalid) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <Sketchbook style={{ width: '100%', maxWidth: 520 }}>
            <div style={{ textAlign: 'center' }}>
              <SectionTitle size={48} underline="orange">
                INVALID INVITE
              </SectionTitle>
              <div style={{ marginTop: 36, display: 'flex', justifyContent: 'center' }}>
                <BurstSticker bg="var(--orange)" rot={-3} w={220} h={140}>
                  OOPS!
                </BurstSticker>
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 20, color: 'rgba(26,20,23,0.7)' }}>
                {invalidMessage}
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
            <SectionTitle size={56} underline="pink">
              NEW ACCOUNT
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="purple" rot={6}>
                1ST TIME
              </TagSticker>
            </div>
            {inviterName && (
              <div className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}>
                invited by <span style={{ color: 'var(--pink)' }}>{inviterName}</span> ♥
              </div>
            )}
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 520 }}>
            <NotebookField
              label="your name:"
              value={displayName}
              onChange={setDisplayName}
              placeholder="what should we call you?"
              required
              autoFocus
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
                  !displayName.trim() ||
                  password !== confirmPassword
                }
              >
                {isSubmitting ? 'CREATING…' : 'CREATE ACCOUNT'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>have an account?</BackButton>
              </Link>
            </div>
          </form>

          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="sparkle" size={36} color="var(--purple)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
