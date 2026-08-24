import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../../services/api';
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

/** Mirrors MAX_MESSAGE_LENGTH in worker/src/db/demoRequests.ts. */
const MAX_MESSAGE_LENGTH = 500;

/**
 * The way in for somebody with no invite.
 *
 * This screen existed before and was deleted along with everything email-shaped
 * (84d9624), because approving a request used to mean sending mail and the app
 * stopped being able to. What comes back is the queue, not the mail: the
 * request lands in root's backroom, and the invite that answers it is a link
 * root passes on by hand — which is why the address asked for here is a
 * reply-to, not a login. It never becomes part of an account.
 *
 * So the copy promises only what is actually true. "We'll get back to you" is
 * a person reading the queue and writing back, and it can take as long as that
 * takes; the old version's "usually within a day or two" was a service level
 * nothing in this app could hold anybody to.
 */
export function RequestDemo() {
  const [email, setEmail] = useState('');
  const [displayName, setDisplayName] = useState('');
  const [message, setMessage] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitted, setSubmitted] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();

    // The same loose shape the Worker checks for, and for the same reason:
    // catching a typo, not policing which addresses exist.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
      setError('That address looks off — we need one we can reply to.');
      return;
    }
    if (!trimmedName) {
      setError('Please tell us what to call you.');
      return;
    }

    setIsSubmitting(true);
    try {
      await api.submitDemoRequest(trimmedEmail, trimmedName, message);
      setSubmitted(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Sending failed. Try again in a minute.');
    } finally {
      setIsSubmitting(false);
    }
  };

  if (submitted) {
    return (
      <div className="app">
        <div className="screen" style={{ display: 'grid', placeItems: 'center', minHeight: 600 }}>
          <Sketchbook style={{ width: '100%', maxWidth: 560 }}>
            <div style={{ textAlign: 'center' }}>
              <SectionTitle size={48} underline="pink">
                GOT IT!
              </SectionTitle>
              <div style={{ marginTop: 28, display: 'flex', justifyContent: 'center' }}>
                <Doodle kind="envelope" size={72} color="var(--pink)" />
              </div>
              <p className="hand" style={{ fontSize: 22, marginTop: 22, color: 'rgba(26,20,23,0.75)' }}>
                it's in the pile. we'll write back to{' '}
                <span style={{ color: 'var(--purple)' }}>{email.trim()}</span> with an invite link
                if there's room.
              </p>
              <p className="hand" style={{ fontSize: 18, marginTop: 6, color: 'rgba(26,20,23,0.55)' }}>
                (a person reads these, so give it a few days — and no need to send another ♥)
              </p>
              <div style={{ marginTop: 32, display: 'flex', justifyContent: 'center' }}>
                <Link to="/login" style={{ textDecoration: 'none' }}>
                  <BackButton>back to sign in</BackButton>
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
            <SectionTitle size={52} underline="purple">
              REQUEST A DEMO
            </SectionTitle>
            <div style={{ position: 'absolute', right: 0, top: -4 }}>
              <TagSticker color="orange" rot={6}>
                GUEST
              </TagSticker>
            </div>
            <div className="hand" style={{ fontSize: 22, color: 'rgba(26,20,23,0.7)', marginTop: 14 }}>
              no invite yet? leave your details and we'll send one over.
            </div>
          </div>

          <form onSubmit={handleSubmit} style={{ marginTop: 16, maxWidth: 520 }}>
            <NotebookField
              label="your name:"
              value={displayName}
              onChange={setDisplayName}
              placeholder="what should we call you?"
              required
              autoFocus
              disabled={isSubmitting}
              maxLength={80}
            />

            <NotebookField
              label="email:"
              type="email"
              value={email}
              onChange={setEmail}
              placeholder="you@somewhere.com"
              required
              disabled={isSubmitting}
              autoComplete="email"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              maxLength={254}
              hint="only used to answer you — it never becomes your login"
            />

            {/* Optional message — long-form free text. The notebook field
                is single-line by design (handwriting label + ruled
                underline); for a multi-line note we drop a plain textarea
                with matching styling so it doesn't clash visually. */}
            <div style={{ marginTop: 18 }}>
              <label
                className="hand"
                htmlFor="demo-message"
                style={{
                  display: 'block',
                  fontSize: 20,
                  color: 'rgba(26,20,23,0.75)',
                  marginBottom: 6,
                }}
              >
                why do you want to try it? <span style={{ color: 'rgba(26,20,23,0.45)' }}>(optional)</span>
              </label>
              <textarea
                id="demo-message"
                value={message}
                onChange={(e) => setMessage(e.target.value.slice(0, MAX_MESSAGE_LENGTH))}
                placeholder="watch movies with my partner? screen share with a friend? just curious?"
                disabled={isSubmitting}
                rows={4}
                maxLength={MAX_MESSAGE_LENGTH}
                style={{
                  width: '100%',
                  fontFamily: 'var(--font-hand)',
                  fontSize: 20,
                  color: 'var(--ink)',
                  background: 'transparent',
                  border: 'none',
                  borderBottom: '3px solid var(--ink)',
                  padding: '8px 4px',
                  resize: 'vertical',
                  outline: 'none',
                  lineHeight: 1.5,
                }}
              />
              <div
                className="hand"
                aria-live="polite"
                style={{ marginTop: 4, fontSize: 14, color: 'rgba(26,20,23,0.5)', textAlign: 'right' }}
              >
                {message.length} / {MAX_MESSAGE_LENGTH}
              </div>
            </div>

            {error && (
              <div className="shake" style={{ marginTop: 18 }} role="alert">
                <BurstSticker bg="var(--orange)" rot={-4} w={180} h={120}>
                  OOPS!
                </BurstSticker>
                <div className="hand" style={{ fontSize: 18, marginTop: 6, color: 'var(--ink)' }}>{error}</div>
              </div>
            )}

            <div className="row" style={{ gap: 18, marginTop: 28, flexWrap: 'wrap' }}>
              <StickerButton
                type="submit"
                color="purple"
                size="xl"
                sfx="SEND!"
                sparks
                disabled={isSubmitting || !email.trim() || !displayName.trim()}
              >
                {isSubmitting ? 'SENDING…' : 'SEND REQUEST'}
              </StickerButton>
              <Link to="/login" style={{ textDecoration: 'none' }}>
                <BackButton>have an invite?</BackButton>
              </Link>
            </div>
          </form>

          <div className="margin-doodles" style={{ position: 'absolute', right: 40, bottom: 60 }}>
            <span className="bob" style={{ display: 'inline-block' }}>
              <Doodle kind="sparkle" size={36} color="var(--pink)" />
            </span>
          </div>
        </Sketchbook>
      </div>
    </div>
  );
}
