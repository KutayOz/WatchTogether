import { useState } from 'react';
import { api } from '../../services/api';
import {
  SectionTitle,
  StickerButton,
  BackButton,
  Doodle,
} from '../manga';
import { ModalShell } from './AdminModal';
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
    <div>
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline', gap: 12 }}>
        <SectionTitle size={26} underline="pink">
          DEMO REQUESTS
        </SectionTitle>
        <span className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)' }}>
          {pending.length} waiting
        </span>
      </div>

      {error && (
        <div
          className="shake"
          style={{
            marginBottom: 12,
            padding: '10px 14px',
            border: '3px solid var(--ink)',
            background: 'var(--orange)',
            fontWeight: 700,
          }}
        >
          {error}
        </div>
      )}

      {requests.length === 0 && (
        <div
          className="hand"
          style={{
            padding: '28px 20px',
            textAlign: 'center',
            fontSize: 22,
            color: 'rgba(26,20,23,0.5)',
            border: '3px dashed rgba(26,20,23,0.25)',
          }}
        >
          <Doodle kind="envelope" size={40} color="rgba(26,20,23,0.35)" />
          <div style={{ marginTop: 10 }}>nothing in the pile.</div>
        </div>
      )}

      <div style={{ display: 'grid', gap: 14 }}>
        {pending.map((request) => (
          <RequestCard
            key={request.id}
            request={request}
            actions={
              <>
                <StickerButton
                  color="purple"
                  size="md"
                  sfx="YES!"
                  disabled={isSubmitting}
                  onClick={() => handleApprove(request)}
                >
                  APPROVE
                </StickerButton>
                <BackButton
                  color="cream"
                  onClick={() => {
                    setRejecting(request);
                    setReason('');
                  }}
                >
                  not now
                </BackButton>
              </>
            }
          />
        ))}
      </div>

      {reviewed.length > 0 && (
        <>
          <div
            className="hand"
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 12,
              margin: '26px 0 14px',
              fontSize: 18,
              color: 'rgba(26,20,23,0.45)',
            }}
          >
            <span style={{ flex: 1, borderTop: '2px dashed rgba(26,20,23,0.25)' }} />
            already dealt with
            <span style={{ flex: 1, borderTop: '2px dashed rgba(26,20,23,0.25)' }} />
          </div>

          {/* Kept for a month after the decision, then swept by the nightly
              cron. The audit log keeps the decision itself for good. */}
          <div style={{ display: 'grid', gap: 14, opacity: 0.72 }}>
            {reviewed.map((request) => (
              <RequestCard
                key={request.id}
                request={request}
                actions={
                  request.status === 'approved' ? (
                    <BackButton
                      color="cream"
                      onClick={() => handleApprove(request)}
                    >
                      {/* The first link was shown once and is gone; this mints
                          a fresh one rather than leaving root stuck. */}
                      new link
                    </BackButton>
                  ) : null
                }
              />
            ))}
          </div>
        </>
      )}

      {/* The invite, shown exactly once — the server keeps only its hash. */}
      {invite && (
        <ModalShell title="INVITE LINK" onClose={closeInvite}>
          <p className="hand" style={{ fontSize: 20, color: 'rgba(26,20,23,0.75)' }}>
            send this to <span style={{ color: 'var(--purple)' }}>{invite.name}</span>. it works
            once and expires in 48h.
          </p>

          <div
            style={{
              marginTop: 14,
              padding: '10px 12px',
              border: '3px solid var(--ink)',
              background: 'var(--cream)',
              fontFamily: 'monospace',
              fontSize: 12,
              wordBreak: 'break-all',
            }}
          >
            {invite.url}
          </div>

          <p className="hand" style={{ fontSize: 17, marginTop: 10, color: 'var(--orange-deep)' }}>
            · copy it now — closing this is the last you will see of it.
          </p>

          <div className="row" style={{ gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <StickerButton
              color="purple"
              sfx="KLIK"
              onClick={() => {
                navigator.clipboard
                  ?.writeText(invite.url)
                  .then(() => setCopied(true))
                  // Clipboard access can be refused outright; the link is on
                  // screen and selectable either way, so this is not an error.
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'COPIED!' : 'COPY LINK'}
            </StickerButton>
            <BackButton onClick={closeInvite}>done</BackButton>
          </div>
        </ModalShell>
      )}

      {/* Closing a request. The note is for root's own memory — nothing shows
          it to the applicant, who is never told anything by this app. */}
      {rejecting && (
        <ModalShell title="CLOSE REQUEST?" onClose={() => setRejecting(null)}>
          <p className="hand" style={{ fontSize: 20, color: 'rgba(26,20,23,0.75)' }}>
            {rejecting.displayName} stays out, and this cannot be undone — though they can apply
            again, and you can always invite them from the lobby.
          </p>

          <label
            className="hand"
            htmlFor="reject-reason"
            style={{ display: 'block', marginTop: 16, fontSize: 18, color: 'rgba(26,20,23,0.6)' }}
          >
            a note for yourself (optional)
          </label>
          <textarea
            id="reject-reason"
            value={reason}
            onChange={(e) => setReason(e.target.value.slice(0, MAX_REJECTION_REASON))}
            rows={3}
            maxLength={MAX_REJECTION_REASON}
            style={{
              width: '100%',
              marginTop: 6,
              padding: '8px 10px',
              border: '3px solid var(--ink)',
              background: 'var(--cream)',
              fontFamily: 'var(--font-hand)',
              fontSize: 18,
              resize: 'vertical',
            }}
          />

          <div className="row" style={{ gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <StickerButton color="orange" sfx="KLIK" onClick={handleReject} disabled={isSubmitting}>
              {isSubmitting ? 'CLOSING…' : 'CLOSE IT'}
            </StickerButton>
            <BackButton onClick={() => setRejecting(null)}>nevermind</BackButton>
          </div>
        </ModalShell>
      )}
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
    <div
      style={{
        border: '3px solid var(--ink)',
        background: 'var(--cream)',
        boxShadow: '5px 5px 0 rgba(26,20,23,0.15)',
        padding: '16px 18px',
      }}
    >
      <div className="row" style={{ alignItems: 'baseline', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 16, letterSpacing: 0.5 }}>
          {request.displayName}
        </span>
        <StatusPill status={request.status} />
        <span style={{ flex: 1 }} />
        <span className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)' }}>
          {formatDate(request.submittedAt)}
        </span>
      </div>

      <a
        href={`mailto:${request.email}`}
        style={{
          display: 'inline-block',
          marginTop: 6,
          fontFamily: 'monospace',
          fontSize: 13,
          color: 'var(--purple)',
          wordBreak: 'break-all',
        }}
      >
        {request.email}
      </a>

      {request.message && (
        <p
          className="hand"
          style={{
            marginTop: 12,
            paddingLeft: 12,
            borderLeft: '3px solid rgba(123,63,228,0.35)',
            fontSize: 19,
            color: 'rgba(26,20,23,0.75)',
            whiteSpace: 'pre-wrap',
          }}
        >
          {request.message}
        </p>
      )}

      {request.rejectionReason && (
        <p className="hand" style={{ marginTop: 10, fontSize: 17, color: 'var(--orange-deep)' }}>
          your note: {request.rejectionReason}
        </p>
      )}

      {actions && (
        <div className="row" style={{ gap: 12, marginTop: 14, flexWrap: 'wrap' }}>
          {actions}
        </div>
      )}
    </div>
  );
}

function StatusPill({ status }: { status: AdminDemoRequest['status'] }) {
  const look =
    status === 'approved'
      ? { bg: 'var(--purple)', fg: 'var(--cream)', label: 'APPROVED' }
      : status === 'rejected'
        ? { bg: 'var(--orange)', fg: 'var(--ink)', label: 'CLOSED' }
        : { bg: 'var(--pink)', fg: 'var(--ink)', label: 'WAITING' };

  return (
    <span
      style={{
        fontFamily: 'var(--font-sfx)',
        fontSize: 11,
        letterSpacing: 1,
        padding: '2px 8px',
        background: look.bg,
        color: look.fg,
        border: '2px solid var(--ink)',
        borderRadius: 4,
      }}
    >
      {look.label}
    </span>
  );
}
