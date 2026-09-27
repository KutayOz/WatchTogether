import { useRef, useState } from 'react';
import { AnimatePresence, m } from 'motion/react';
import { api } from '../../services/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { TextArea } from '../ui/Field';
import { ScrambleText } from '../ui/ScrambleText';
import { AlertIcon, CheckIcon, CopyIcon, InboxIcon, MailIcon, TicketIcon } from '../ui/icons';
import { sparkle } from '../ui/interactions';
import { cascade, rise } from '../ui/motion';
import type { AdminDemoRequest } from '../../types';

const MAX_REJECTION_REASON = 500;

/**
 * The demo-request queue.
 *
 * Cards rather than a table, unlike every other list in the backroom: a request
 * carries up to 500 characters of somebody explaining why they want in, and
 * that is the part root actually reads. A table cell would either clip it or
 * blow the row heights out.
 *
 * Approving mints an invite link and shows it once — the server keeps only its
 * hash — so the dialog that shows it is also the only chance to copy it. That
 * is the same deal as the password reset link, and it is deliberate: an app
 * that cannot send mail should not pretend the link went anywhere.
 *
 * The address is a mailto:, because answering is the actual next step and root
 * is going to do it in their own mail client either way.
 */
export function DemoRequests({
  requests,
  onRefresh,
}: {
  requests: AdminDemoRequest[];
  onRefresh: () => void;
}) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invite, setInvite] = useState<{ name: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rejecting, setRejecting] = useState<AdminDemoRequest | null>(null);
  const [reason, setReason] = useState('');
  const copyRef = useRef<HTMLButtonElement>(null);

  const pending = requests.filter((r) => r.status === 'pending');
  const reviewed = requests.filter((r) => r.status !== 'pending');

  /**
   * Approve, and hold the link on screen until root dismisses it.
   *
   * Refreshing here would destroy the only copy: the dashboard drops into its
   * loading state while it reloads, which unmounts this panel and takes the
   * open dialog — and the link inside it — with it. So the reload waits for the
   * dialog to close, and until then the card underneath is a few seconds stale.
   */
  const handleApprove = async (request: AdminDemoRequest) => {
    setIsSubmitting(true);
    setError(null);
    setCopied(false);
    try {
      const { inviteUrl } = await api.approveAdminDemoRequest(request.id);
      setInvite({ name: request.displayName, url: inviteUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve the request');
    } finally {
      setIsSubmitting(false);
    }
  };

  const closeInvite = () => {
    setInvite(null);
    onRefresh();
  };

  const handleReject = async () => {
    if (!rejecting) return;
    setIsSubmitting(true);
    setError(null);
    try {
      await api.rejectAdminDemoRequest(rejecting.id, reason);
      setRejecting(null);
      setReason('');
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to close the request');
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="stack" style={{ ['--gap' as string]: '16px' }}>
      <p className="muted">
        {pending.length === 0
          ? 'Nothing waiting.'
          : `${pending.length} ${pending.length === 1 ? 'person is' : 'people are'} waiting for an answer.`}
      </p>

      {error && (
        <div className="notice notice--error" role="alert">
          <AlertIcon size={18} />
          <span>{error}</span>
        </div>
      )}

      {requests.length === 0 && (
        <div className="empty">
          <InboxIcon size={30} />
          <p className="empty__title">No requests</p>
          <p className="empty__text">When someone asks for a seat from the sign-in page, it shows up here.</p>
        </div>
      )}

      <m.div className="requests" variants={cascade(0.06)} initial="hidden" animate="shown">
        <AnimatePresence initial={false}>
          {pending.map((request) => (
            <RequestCard
              key={request.id}
              request={request}
              actions={
                <>
                  <Button
                    variant="primary"
                    size="sm"
                    icon={<TicketIcon size={16} />}
                    disabled={isSubmitting}
                    onClick={() => handleApprove(request)}
                  >
                    Approve and make link
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setRejecting(request);
                      setReason('');
                    }}
                  >
                    Not now
                  </Button>
                </>
              }
            />
          ))}
        </AnimatePresence>
      </m.div>

      {reviewed.length > 0 && (
        <>
          <div className="divider">Already answered</div>
          {/* Kept for a month after the decision, then swept by the nightly
              cron. The audit log keeps the decision itself for good. */}
          <div className="requests requests--done">
            {reviewed.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                actions={
                  request.status === 'approved' ? (
                    // The first link was shown once and is gone; this mints a
                    // fresh one rather than leaving root stuck.
                    <Button variant="secondary" size="sm" onClick={() => handleApprove(request)}>
                      Make a new link
                    </Button>
                  ) : null
                }
              />
            ))}
          </div>
        </>
      )}

      {/* The invite, shown exactly once — the server keeps only its hash. */}
      <Modal
        isOpen={invite !== null}
        onClose={closeInvite}
        title="Invite link"
        description={invite ? `Send this to ${invite.name}. It works once and expires in 48 hours.` : undefined}
        footer={
          <>
            <Button variant="secondary" onClick={closeInvite}>
              Done
            </Button>
            <Button
              ref={copyRef}
              variant="primary"
              data-autofocus=""
              icon={copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
              onClick={() => {
                if (!invite) return;
                navigator.clipboard
                  ?.writeText(invite.url)
                  .then(() => {
                    setCopied(true);
                    sparkle(copyRef.current);
                  })
                  // Clipboard access can be refused outright; the link is on
                  // screen and selectable either way, so this is not an error.
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'Copied' : 'Copy link'}
            </Button>
          </>
        }
      >
        {invite && (
          <div className="stack" style={{ ['--gap' as string]: '12px' }}>
            <div className="invite-ticket">
              <div className="invite-ticket__label">Invite link</div>
              <ScrambleText text={invite.url} className="invite-ticket__url" />
            </div>
            <div className="notice notice--warn">
              <AlertIcon size={18} />
              <span>Copy it now. Closing this is the last you’ll see of it.</span>
            </div>
          </div>
        )}
      </Modal>

      {/* Closing a request. The note is for root's own memory — nothing shows
          it to the applicant, who is never told anything by this app. */}
      <Modal
        isOpen={rejecting !== null}
        onClose={() => setRejecting(null)}
        title="Close this request?"
        description={
          rejecting
            ? `${rejecting.displayName} stays out, and this can’t be undone. They can apply again, and you can always invite them from the lobby.`
            : undefined
        }
        footer={
          <>
            <Button variant="ghost" onClick={() => setRejecting(null)}>
              Keep it open
            </Button>
            <Button variant="danger" onClick={handleReject} loading={isSubmitting} disabled={isSubmitting}>
              {isSubmitting ? 'Closing…' : 'Close request'}
            </Button>
          </>
        }
      >
        <TextArea
          label="A note for yourself"
          note="(optional)"
          value={reason}
          onValueChange={(v) => setReason(v.slice(0, MAX_REJECTION_REASON))}
          rows={3}
          maxLength={MAX_REJECTION_REASON}
          aside={`${reason.length} / ${MAX_REJECTION_REASON}`}
          data-autofocus=""
        />
      </Modal>
    </div>
  );
}

function RequestCard({
  request,
  actions,
}: {
  request: AdminDemoRequest;
  actions: React.ReactNode;
}) {
  const formatDate = (millis: number) =>
    new Date(millis).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });

  return (
    <m.article
      className="request"
      variants={rise}
      layout
      exit={{ opacity: 0, scale: 0.97, transition: { duration: 0.18 } }}
      aria-label={`Request from ${request.displayName}`}
    >
      <header className="request__head">
        <span className="avatar" data-who="neutral" style={{ ['--av' as string]: '36px' }} aria-hidden="true">
          {request.displayName.charAt(0).toUpperCase()}
        </span>
        <div className="request__who">
          <span className="request__name">{request.displayName}</span>
          <a className="request__email" href={`mailto:${request.email}`}>
            <MailIcon size={14} />
            {request.email}
          </a>
        </div>
        <StatusPill status={request.status} />
        <time className="request__date" dateTime={new Date(request.submittedAt).toISOString()}>
          {formatDate(request.submittedAt)}
        </time>
      </header>

      {request.message && <p className="request__message">{request.message}</p>}

      {request.rejectionReason && <p className="request__note">Your note: {request.rejectionReason}</p>}

      {actions && <div className="request__actions">{actions}</div>}
    </m.article>
  );
}

function StatusPill({ status }: { status: AdminDemoRequest['status'] }) {
  if (status === 'approved') return <span className="chip chip--teal">Approved</span>;
  if (status === 'rejected') return <span className="chip chip--exit">Closed</span>;
  return (
    <span className="chip chip--amber">
      <span className="chip__dot" data-live="" aria-hidden="true" />
      Waiting
    </span>
  );
}
