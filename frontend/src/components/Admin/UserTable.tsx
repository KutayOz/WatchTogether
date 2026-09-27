import { useRef, useState } from 'react';
import { api } from '../../services/api';
import { Button } from '../ui/Button';
import { Modal } from '../ui/Modal';
import { ScrambleText } from '../ui/ScrambleText';
import { AlertIcon, CheckIcon, CopyIcon, LockIcon, TrashIcon, UsersIcon } from '../ui/icons';
import { sparkle } from '../ui/interactions';
import type { AdminUser } from '../../types';

interface UserTableProps {
  users: AdminUser[];
  onRefresh: () => void;
}

export function UserTable({ users, onRefresh }: UserTableProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<AdminUser | null>(null);
  const [resetLink, setResetLink] = useState<{ tag: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const copyRef = useRef<HTMLButtonElement>(null);

  /**
   * Mint a password reset link.
   *
   * The whole of account recovery: no email address exists anywhere in this
   * system, so nothing can be sent anywhere — root generates the link and
   * passes it on however they already talk to the person. It also works on an
   * account that has never had a password, which is how a passkey-only user
   * gets one.
   */
  const handleResetPassword = async (u: AdminUser) => {
    setIsSubmitting(true);
    setError(null);
    setCopied(false);
    try {
      const { resetUrl } = await api.adminResetPassword(u.id);
      setResetLink({ tag: u.tag, url: resetUrl });
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to create a reset link');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDelete = async (id: string) => {
    setIsSubmitting(true);
    setError(null);
    try {
      await api.deleteAdminUser(id);
      setDeleteConfirm(null);
      onRefresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete user');
    } finally {
      setIsSubmitting(false);
    }
  };

  const formatDate = (millis: number) =>
    new Date(millis).toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });

  if (users.length === 0) {
    return (
      <div className="empty">
        <UsersIcon size={30} />
        <p className="empty__title">Nobody yet</p>
      </div>
    );
  }

  return (
    <div className="stack" style={{ ['--gap' as string]: '14px' }}>
      {error && (
        <div className="notice notice--error" role="alert">
          <AlertIcon size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className="people" role="table" aria-label="People">
        <div className="people__row people__row--head" role="row">
          <span role="columnheader">Person</span>
          <span role="columnheader">Status</span>
          <span role="columnheader">Joined</span>
          <span role="columnheader" className="people__actions-head">
            Actions
          </span>
        </div>
        {users.map((u) => (
          <div className="people__row" role="row" key={u.id} data-deleted={u.isDeleted ? '' : undefined}>
            <span role="cell" className="people__person">
              <span
                className="avatar"
                data-who={u.isRootUser ? undefined : 'them'}
                style={{ ['--av' as string]: '36px' }}
                aria-hidden="true"
              >
                {u.username.charAt(0).toUpperCase()}
              </span>
              <span className="people__name">
                <span className="people__username">{u.username}</span>
                {/* The tag, not an email — it is what makes two people called
                    "kutay" distinguishable, and the only handle admins can act on. */}
                <span className="people__tag">{u.tag}</span>
              </span>
            </span>
            <span role="cell" className="people__status">
              {u.isRootUser && <span className="chip chip--amber">Root</span>}
              {u.isDeleted ? <span className="chip chip--exit">Deleted</span> : !u.isRootUser && <span className="chip">Active</span>}
            </span>
            <span role="cell" className="people__joined">
              <span className="people__cell-label">Joined </span>
              {formatDate(u.createdAt)}
            </span>
            <span role="cell" className="people__actions">
              {/* Reset and delete. The Worker exposes no other user-update
                  endpoint, and root is undeletable server-side as well as
                  here — though root can still be issued a reset link, since
                  losing the only admin password is exactly when you need
                  one most. */}
              {!u.isDeleted && (
                <>
                  <Button
                    size="sm"
                    variant="secondary"
                    icon={<LockIcon size={16} />}
                    onClick={() => handleResetPassword(u)}
                    disabled={isSubmitting}
                  >
                    Reset password
                  </Button>
                  {!u.isRootUser && (
                    <Button
                      size="sm"
                      variant="ghost"
                      className="people__delete"
                      icon={<TrashIcon size={16} />}
                      onClick={() => setDeleteConfirm(u)}
                    >
                      Delete
                    </Button>
                  )}
                </>
              )}
            </span>
          </div>
        ))}
      </div>

      {/* Reset link, shown exactly once — the server keeps only its hash. */}
      <Modal
        isOpen={resetLink !== null}
        onClose={() => setResetLink(null)}
        title="Reset link"
        description={
          resetLink ? `Give this to ${resetLink.tag}. It works once, expires in 48 hours, and any earlier link for them is now dead.` : undefined
        }
        footer={
          <>
            <Button variant="secondary" onClick={() => setResetLink(null)}>
              Done
            </Button>
            <Button
              ref={copyRef}
              variant="primary"
              icon={copied ? <CheckIcon size={18} /> : <CopyIcon size={18} />}
              data-autofocus=""
              onClick={() => {
                if (!resetLink) return;
                navigator.clipboard
                  ?.writeText(resetLink.url)
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
        {resetLink && (
          <div className="stack" style={{ ['--gap' as string]: '12px' }}>
            <div className="invite-ticket" style={{ borderStyle: 'solid' }}>
              <div className="invite-ticket__label">Reset link</div>
              <ScrambleText text={resetLink.url} className="invite-ticket__url" />
            </div>
            <div className="notice notice--warn">
              <AlertIcon size={18} />
              <span>Copy it now. Closing this is the last you’ll see of it.</span>
            </div>
          </div>
        )}
      </Modal>

      <Modal
        isOpen={deleteConfirm !== null}
        onClose={() => setDeleteConfirm(null)}
        title="Delete this person?"
        description={
          deleteConfirm ? `${deleteConfirm.tag} loses their account. This can’t be undone.` : undefined
        }
        width={460}
        footer={
          <>
            <Button variant="ghost" onClick={() => setDeleteConfirm(null)}>
              Keep them
            </Button>
            <Button
              variant="danger"
              icon={<TrashIcon size={17} />}
              loading={isSubmitting}
              disabled={isSubmitting}
              onClick={() => deleteConfirm && handleDelete(deleteConfirm.id)}
            >
              {isSubmitting ? 'Deleting…' : 'Delete'}
            </Button>
          </>
        }
      />
    </div>
  );
}
