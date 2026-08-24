import { useState } from 'react';
import { api } from '../../services/api';
import {
  SectionTitle,
  StickerButton,
  BackButton,
  BurstSticker,
  TagSticker,
} from '../manga';
import { ModalShell } from './AdminModal';
import type { AdminUser } from '../../types';

interface UserTableProps {
  users: AdminUser[];
  onRefresh: () => void;
}

export function UserTable({ users, onRefresh }: UserTableProps) {
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [deleteConfirm, setDeleteConfirm] = useState<string | null>(null);
  const [resetLink, setResetLink] = useState<{ tag: string; url: string } | null>(null);
  const [copied, setCopied] = useState(false);

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

  return (
    <div>
      <div className="row" style={{ marginBottom: 16, alignItems: 'baseline', gap: 12 }}>
        <SectionTitle size={26} underline="pink">
          USERS
        </SectionTitle>
        <span className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)' }}>
          {users.length} total
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

      <div
        style={{
          overflowX: 'auto',
          border: '3px solid var(--ink)',
          borderRadius: 4,
          background: 'var(--cream)',
          backgroundImage:
            'repeating-linear-gradient(0deg, transparent 0 31px, rgba(123,63,228,0.12) 31px 32px)',
        }}
      >
        <table style={{ width: '100%', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ borderBottom: '3px solid var(--ink)' }}>
              <Th>user</Th>
              <Th>tag</Th>
              <Th>status</Th>
              <Th>joined</Th>
              <Th align="right">actions</Th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id} style={{ borderBottom: '2px dashed rgba(26,20,23,0.15)' }}>
                <Td>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <div
                      style={{
                        width: 30,
                        height: 30,
                        display: 'grid',
                        placeItems: 'center',
                        background: u.isRootUser ? 'var(--purple)' : 'var(--pink)',
                        color: u.isRootUser ? 'var(--cream)' : 'var(--ink)',
                        border: '2.5px solid var(--ink)',
                        borderRadius: '50%',
                        fontFamily: 'var(--font-sfx)',
                        fontSize: 14,
                      }}
                    >
                      {u.username.charAt(0).toUpperCase()}
                    </div>
                    <span style={{ fontFamily: 'var(--font-sfx)', fontSize: 15, letterSpacing: 0.5 }}>
                      {u.username}
                    </span>
                    {u.isRootUser && <TagSticker color="orange" rot={3}>ROOT</TagSticker>}
                  </div>
                </Td>
                <Td>
                  {/* The tag, not an email — it is what makes two people called
                      "kutay" distinguishable, and the only handle admins can act on. */}
                  <span style={{ fontSize: 13, fontFamily: 'monospace' }}>{u.tag}</span>
                </Td>
                <Td>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {u.isDeleted && <Pill bg="var(--orange)">DELETED</Pill>}
                    {u.isRootUser && <Pill bg="var(--purple)" fg="var(--cream)">ROOT</Pill>}
                  </div>
                </Td>
                <Td>
                  <span className="hand" style={{ fontSize: 16 }}>{formatDate(u.createdAt)}</span>
                </Td>
                <Td align="right">
                  {/* Reset and delete. The Worker exposes no other user-update
                      endpoint, and root is undeletable server-side as well as
                      here — though root can still be issued a reset link, since
                      losing the only admin password is exactly when you need
                      one most. */}
                  {!u.isDeleted && (
                    <div style={{ display: 'inline-flex', gap: 8, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                      <ActionBtn
                        onClick={() => handleResetPassword(u)}
                        color="purple"
                        disabled={isSubmitting}
                      >
                        reset password
                      </ActionBtn>
                      {!u.isRootUser && (
                        <ActionBtn onClick={() => setDeleteConfirm(u.id)} color="orange">
                          delete
                        </ActionBtn>
                      )}
                    </div>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>


      {/* Reset link, shown exactly once — the server keeps only its hash. */}
      {resetLink && (
        <ModalShell title="RESET LINK" onClose={() => setResetLink(null)}>
          <p className="hand" style={{ fontSize: 20, color: 'rgba(26,20,23,0.75)' }}>
            hand this to <span style={{ color: 'var(--purple)' }}>{resetLink.tag}</span>. it works
            once, expires in 48h, and any earlier link for them is now dead.
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
            {resetLink.url}
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
                  ?.writeText(resetLink.url)
                  .then(() => setCopied(true))
                  // Clipboard access can be refused outright; the link is on
                  // screen and selectable either way, so this is not an error.
                  .catch(() => setCopied(false));
              }}
            >
              {copied ? 'COPIED!' : 'COPY LINK'}
            </StickerButton>
            <BackButton onClick={() => setResetLink(null)}>done</BackButton>
          </div>
        </ModalShell>
      )}

      {/* Delete confirm */}
      {deleteConfirm && (
        <ModalShell title="DELETE USER?" onClose={() => setDeleteConfirm(null)}>
          <BurstSticker bg="var(--orange)" rot={-4} w={220} h={130}>
            HOLD UP!
          </BurstSticker>
          <p className="hand" style={{ fontSize: 22, marginTop: 14, color: 'rgba(26,20,23,0.75)' }}>
            this can't be undone.
          </p>
          <div className="row" style={{ gap: 12, marginTop: 20, flexWrap: 'wrap' }}>
            <StickerButton color="orange" sfx="KLIK" onClick={() => handleDelete(deleteConfirm)} disabled={isSubmitting}>
              {isSubmitting ? 'DELETING…' : 'YES, DELETE'}
            </StickerButton>
            <BackButton onClick={() => setDeleteConfirm(null)}>nevermind</BackButton>
          </div>
        </ModalShell>
      )}
    </div>
  );
}

function Th({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return (
    <th
      style={{
        textAlign: align,
        padding: '10px 12px',
        fontFamily: 'var(--font-sfx)',
        fontSize: 14,
        letterSpacing: 1.2,
        color: 'var(--purple)',
      }}
    >
      {children}
    </th>
  );
}

function Td({ children, align = 'left' }: { children: React.ReactNode; align?: 'left' | 'right' | 'center' }) {
  return (
    <td
      style={{
        textAlign: align,
        padding: '10px 12px',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--ink)',
        verticalAlign: 'middle',
      }}
    >
      {children}
    </td>
  );
}

function Pill({ children, bg, fg = 'var(--ink)' }: { children: React.ReactNode; bg: string; fg?: string }) {
  return (
    <span
      style={{
        fontFamily: 'var(--font-sfx)',
        fontSize: 11,
        letterSpacing: 1,
        padding: '2px 8px',
        background: bg,
        color: fg,
        border: '2px solid var(--ink)',
        borderRadius: 4,
        display: 'inline-block',
        width: 'fit-content',
      }}
    >
      {children}
    </span>
  );
}

function ActionBtn({
  children,
  onClick,
  color,
  disabled,
}: {
  children: React.ReactNode;
  onClick: () => void;
  color: 'purple' | 'orange';
  disabled?: boolean;
}) {
  const fg = color === 'purple' ? 'var(--purple-deep)' : 'var(--orange-deep)';
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        background: 'transparent',
        border: '2px solid var(--ink)',
        borderRadius: 8,
        padding: '4px 10px',
        fontFamily: 'var(--font-hand)',
        fontWeight: 700,
        fontSize: 16,
        color: fg,
        cursor: 'pointer',
      }}
    >
      {children}
    </button>
  );
}
