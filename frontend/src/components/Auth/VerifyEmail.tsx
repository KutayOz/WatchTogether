import { useState, useEffect } from 'react';
import { useNavigate, useParams, Link } from 'react-router-dom';
import { api } from '../../services/api';
import {
  SectionTitle,
  StickerButton,
  BurstSticker,
  BackButton,
  Doodle,
} from '../manga';

export function VerifyEmail() {
  const navigate = useNavigate();
  const { token } = useParams<{ token: string }>();
  const [isVerifying, setIsVerifying] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  useEffect(() => {
    if (token) {
      verifyEmail();
    } else {
      setError('Invalid verification link');
      setIsVerifying(false);
    }

  }, [token]);

  const verifyEmail = async () => {
    if (!token) return;

    try {
      const result = await api.verifyEmailByToken(token);
      if (result.success) {
        setSuccess(result.message);
        setTimeout(() => {
          navigate('/login', { replace: true });
        }, 3000);
      } else {
        setError(result.message);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Verification failed');
    } finally {
      setIsVerifying(false);
    }
  };

  return (
    <div className="app">
      <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
        <div style={{ textAlign: 'center', maxWidth: 540, position: 'relative' }}>
          <SectionTitle
            size={48}
            underline={success ? 'pink' : isVerifying ? 'purple' : 'orange'}
          >
            {isVerifying ? 'CHECKING…' : success ? 'VERIFIED!' : 'OOPS'}
          </SectionTitle>

          {/* Envelope graphic */}
          <div style={{ position: 'relative', margin: '40px auto 0', width: 320, height: 220 }}>
            <svg
              width="320"
              height="220"
              viewBox="0 0 360 240"
              style={{
                animation: isVerifying ? 'bob 1.6s ease-in-out infinite' : undefined,
                transformOrigin: 'center',
              }}
              aria-hidden="true"
            >
              <rect x="10" y="40" width="340" height="190" rx="6" fill="var(--cream)" stroke="var(--ink)" strokeWidth="4" />
              <path d="M10 50 L180 150 L350 50" fill="none" stroke="var(--ink)" strokeWidth="4" strokeLinejoin="round" />
              <path d="M10 230 L150 130 M350 230 L210 130" stroke="var(--ink)" strokeWidth="3" fill="none" />
            </svg>

            {success && (
              <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%, -50%)' }}>
                <BurstSticker bg="var(--pink)" rot={-6} w={220} h={150}>
                  TADA!
                </BurstSticker>
              </div>
            )}
            {error && !isVerifying && (
              <div style={{ position: 'absolute', left: '50%', top: 0, transform: 'translate(-50%, -50%)' }}>
                <BurstSticker bg="var(--orange)" rot={-6} w={220} h={150}>
                  OOPS!
                </BurstSticker>
              </div>
            )}
          </div>

          {/* Message */}
          {isVerifying && (
            <p className="hand" style={{ fontSize: 24, marginTop: 28, color: 'rgba(26,20,23,0.7)' }}>
              opening the envelope…
            </p>
          )}
          {success && (
            <>
              <p className="hand" style={{ fontSize: 24, marginTop: 28, color: 'rgba(26,20,23,0.8)' }}>
                {success}
              </p>
              <p className="hand" style={{ fontSize: 20, marginTop: 8, color: 'rgba(26,20,23,0.55)' }}>
                redirecting to login in a moment…
              </p>
            </>
          )}
          {error && !isVerifying && (
            <>
              <p className="hand" style={{ fontSize: 22, marginTop: 28, color: 'var(--ink)' }}>
                {error}
              </p>
              <p className="hand" style={{ fontSize: 18, marginTop: 6, color: 'rgba(26,20,23,0.55)' }}>
                the link may have expired or been used already.
              </p>
            </>
          )}

          <div className="row" style={{ justifyContent: 'center', marginTop: 32, gap: 16, flexWrap: 'wrap' }}>
            {success && (
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <StickerButton color="pink" size="md" sfx="TAP!">
                  GO TO LOGIN
                </StickerButton>
              </Link>
            )}
            {error && (
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>back to login</BackButton>
              </Link>
            )}
          </div>

          {/* Floating doodles */}
          <div style={{ position: 'absolute', left: -40, top: 20 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="sparkle" size={32} color="var(--purple)" />
            </span>
          </div>
          <div style={{ position: 'absolute', right: -30, bottom: 60 }}>
            <span className="bob delay-2" style={{ display: 'inline-block' }}>
              <Doodle kind="heart" size={34} color="var(--pink)" />
            </span>
          </div>
        </div>
      </div>
    </div>
  );
}
