import { useState } from 'react';
import { useLocation, Link, Navigate } from 'react-router-dom';
import { api } from '../../services/api';
import {
  Sketchbook,
  SectionTitle,
  StickerButton,
  BackButton,
  Doodle,
  SpeechBubble,
} from '../manga';

export function CheckEmail() {
  const location = useLocation();
  const email = (location.state as { email?: string })?.email;

  const [isResending, setIsResending] = useState(false);
  const [resendStatus, setResendStatus] = useState<{ kind: 'idle' | 'success' | 'error'; message?: string }>({ kind: 'idle' });

  if (!email) {
    return <Navigate to="/login" replace />;
  }

  const handleResend = async () => {
    setIsResending(true);
    setResendStatus({ kind: 'idle' });
    try {
      await api.resendVerification(email);
      setResendStatus({ kind: 'success', message: 'sent! check your inbox.' });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'failed to resend verification email';
      setResendStatus({ kind: 'error', message });
    } finally {
      setIsResending(false);
    }
  };

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', padding: '20px 0' }}>
        <Sketchbook style={{ width: '100%', maxWidth: 600 }}>
          <div style={{ textAlign: 'center' }}>
            <SectionTitle size={42} underline="purple">
              CHECK YOUR EMAIL
            </SectionTitle>

            <p className="hand" style={{ fontSize: 24, marginTop: 28, lineHeight: 1.4 }}>
              we just slid an envelope under <br />
              <span style={{ color: 'var(--purple)', fontFamily: 'var(--font-sfx)', fontSize: 22, letterSpacing: 1 }}>
                {email}
              </span>
            </p>

            <div style={{ margin: '32px auto 24px', display: 'flex', justifyContent: 'center' }}>
              <svg
                width="220"
                height="160"
                viewBox="0 0 360 240"
                style={{ animation: 'bob 4s ease-in-out infinite' }}
                aria-hidden="true"
              >
                <rect x="10" y="40" width="340" height="190" rx="6" fill="var(--cream-deep)" stroke="var(--ink)" strokeWidth="4" />
                <path d="M10 50 L180 150 L350 50" fill="none" stroke="var(--ink)" strokeWidth="4" strokeLinejoin="round" />
                <path d="M10 230 L150 130 M350 230 L210 130" stroke="var(--ink)" strokeWidth="3" fill="none" />
              </svg>
            </div>

            <p className="hand" style={{ fontSize: 20, color: 'rgba(26,20,23,0.6)', marginTop: 4 }}>
              click the link inside to verify · expires in 24h
            </p>

            {resendStatus.kind !== 'idle' && (
              <div style={{ marginTop: 18, display: 'flex', justifyContent: 'center' }}>
                <SpeechBubble kind="rect" color={resendStatus.kind === 'success' ? 'pink' : 'cream'} small>
                  <span
                    className="hand"
                    style={{
                      fontSize: 18,
                      color: resendStatus.kind === 'error' ? 'var(--orange-deep)' : 'var(--ink)',
                    }}
                  >
                    {resendStatus.message}
                  </span>
                </SpeechBubble>
              </div>
            )}

            <div className="row" style={{ justifyContent: 'center', marginTop: 28, gap: 16, flexWrap: 'wrap' }}>
              <StickerButton color="purple" size="md" sfx="KLIK" onClick={handleResend} disabled={isResending}>
                {isResending ? 'SENDING…' : 'RESEND'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>back to login</BackButton>
              </Link>
            </div>

            <p className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.4)', marginTop: 18 }}>
              ↑ didn't see it? check spam.
            </p>
          </div>

          <div className="margin-doodles" style={{ position: 'absolute', right: 28, top: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="airplane" size={48} color="var(--pink)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
