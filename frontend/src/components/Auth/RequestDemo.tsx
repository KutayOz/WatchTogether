import { useEffect, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { m } from 'motion/react';
import { api } from '../../services/api';
import { Theater } from '../ui/Theater';
import { FocusText } from '../ui/FocusText';
import { Button } from '../ui/Button';
import { TextArea, TextField } from '../ui/Field';
import { AlertIcon, MailIcon, SendIcon } from '../ui/icons';
import { shake, sparkle } from '../ui/interactions';
import { spring } from '../ui/motion';

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
  const errorRef = useRef<HTMLDivElement>(null);
  const sentRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    if (error) shake(errorRef.current);
  }, [error]);

  useEffect(() => {
    if (submitted) {
      const timer = window.setTimeout(() => sparkle(sentRef.current, 'teal'), 350);
      return () => window.clearTimeout(timer);
    }
  }, [submitted]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const trimmedEmail = email.trim();
    const trimmedName = displayName.trim();

    // The same loose shape the Worker checks for, and for the same reason:
    // catching a typo, not policing which addresses exist.
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(trimmedEmail)) {
      setError('That address looks off. We need one we can reply to.');
      return;
    }
    if (!trimmedName) {
      setError('Tell us what to call you.');
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
      <Theater screen={<FocusText as="h1" className="theater__kicker" text="Request received" />}>
        <div className="status-card">
          <m.span
            ref={sentRef}
            className="status-card__icon"
            data-tone="ok"
            aria-hidden="true"
            initial={{ scale: 0.4, rotate: -20, opacity: 0 }}
            animate={{ scale: 1, rotate: 0, opacity: 1 }}
            transition={{ ...spring.lively, delay: 0.2 }}
          >
            <MailIcon size={28} />
          </m.span>
          <h2>It’s in the pile</h2>
          <p>
            We’ll write back to <strong style={{ color: 'var(--amber-hi)' }}>{email.trim()}</strong> with an invite
            link if there’s room.
          </p>
          <p className="muted">A person reads these, so give it a few days. No need to send another.</p>
          <Link to="/login" className="btn btn--secondary" data-light="">
            <span>Back to sign in</span>
          </Link>
        </div>
      </Theater>
    );
  }

  return (
    <Theater
      wide
      back={{ to: '/login', label: 'Sign in' }}
      screen={
        <>
          <FocusText as="h1" className="theater__kicker" text="Ask for a seat" delay={0.35} />
          <m.p initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ delay: 0.9, duration: 0.7 }}>
            No invite yet? Leave your details and we’ll send one over.
          </m.p>
        </>
      }
      foot={
        <p>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      }
    >
      <form onSubmit={handleSubmit} className="stack" style={{ ['--gap' as string]: '18px' }}>
        <TextField
          label="Your name"
          value={displayName}
          onValueChange={setDisplayName}
          placeholder="What should we call you?"
          required
          autoFocus
          disabled={isSubmitting}
          maxLength={80}
          autoComplete="name"
        />

        <TextField
          label="Email"
          type="email"
          value={email}
          onValueChange={setEmail}
          placeholder="you@somewhere.com"
          required
          disabled={isSubmitting}
          autoComplete="email"
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          maxLength={254}
          hint="Only used to reply to you. It never becomes your login."
        />

        <TextArea
          label="Why do you want to try it?"
          note="(optional)"
          value={message}
          onValueChange={(v) => setMessage(v.slice(0, MAX_MESSAGE_LENGTH))}
          placeholder="Movie nights with my partner? Screen sharing with a friend? Just curious?"
          disabled={isSubmitting}
          rows={4}
          maxLength={MAX_MESSAGE_LENGTH}
          aside={`${message.length} / ${MAX_MESSAGE_LENGTH}`}
        />

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
          icon={<SendIcon size={19} />}
          loading={isSubmitting}
          disabled={isSubmitting || !email.trim() || !displayName.trim()}
        >
          {isSubmitting ? 'Sending…' : 'Send request'}
        </Button>
      </form>
    </Theater>
  );
}
