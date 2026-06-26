import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { UserTree } from './UserTree';
import { UserTable } from './UserTable';
import {
  SectionTitle,
  TagSticker,
  ComicPanel,
  BackButton,
  Doodle,
  Modal,
  StickerButton,
} from '../manga';
import type { AdminUser, UserTreeResponse, AdminInvitation, AdminDemoRequest } from '../../types';

type Tab = 'tree' | 'users' | 'invitations' | 'demo-requests';

const STATUS_COLORS: Record<string, { bg: string; fg: string }> = {
  pending:  { bg: 'var(--orange)', fg: 'var(--ink)' },
  used:     { bg: 'var(--pink)',   fg: 'var(--ink)' },
  expired:  { bg: 'rgba(26,20,23,0.1)', fg: 'rgba(26,20,23,0.6)' },
  revoked:  { bg: 'var(--ink)',    fg: 'var(--cream)' },
  approved: { bg: 'var(--pink)',   fg: 'var(--ink)' },
  rejected: { bg: 'var(--ink)',    fg: 'var(--cream)' },
};

export function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [treeData, setTreeData] = useState<UserTreeResponse | null>(null);
  const [invitations, setInvitations] = useState<AdminInvitation[]>([]);
  const [demoRequests, setDemoRequests] = useState<AdminDemoRequest[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user?.isRootUser) {
      navigate('/');
      return;
    }
    loadData();
  }, [user, navigate]);

  const loadData = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const [usersData, treeDataRes, invitationsData, demoData] = await Promise.all([
        api.getAdminUsers(),
        api.getAdminUserTree(),
        api.getAdminInvitations(),
        api.getAdminDemoRequests(),
      ]);
      setUsers(usersData);
      setTreeData(treeDataRes);
      setInvitations(invitationsData);
      setDemoRequests(demoData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };

  const handleDeleteInvitation = async (id: string) => {
    try {
      await api.deleteAdminInvitation(id);
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to delete invitation');
    }
  };

  // Modal state for the demo-requests tab. Approval modal shows the issued
  // invite URL so the admin can copy it as a fallback when the email gets
  // stuck in spam. Reject modal collects the optional internal reason.
  const [approvalModal, setApprovalModal] = useState<{
    requesterName: string;
    requesterEmail: string;
    invitationUrl: string;
    expiresAt?: string;
    /** True when this modal is showing a *re-sent* link (resend action) vs
     *  a fresh approval. Slight copy change but same UI shell. */
    isResend: boolean;
  } | null>(null);
  const [rejectModal, setRejectModal] = useState<{
    id: string;
    requesterName: string;
    requesterEmail: string;
  } | null>(null);
  const [rejectReason, setRejectReason] = useState('');
  const [isModalSubmitting, setIsModalSubmitting] = useState(false);
  const [copyFeedback, setCopyFeedback] = useState<string | null>(null);

  const handleApproveDemoRequest = async (req: AdminDemoRequest) => {
    setIsModalSubmitting(true);
    try {
      const result = await api.approveAdminDemoRequest(req.id);
      if (result.invitationUrl) {
        setApprovalModal({
          requesterName: req.displayName,
          requesterEmail: req.email,
          invitationUrl: result.invitationUrl,
          expiresAt: result.expiresAt,
          isResend: false,
        });
      }
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to approve demo request');
    } finally {
      setIsModalSubmitting(false);
    }
  };

  const handleResendDemoRequest = async (req: AdminDemoRequest) => {
    setIsModalSubmitting(true);
    try {
      const result = await api.resendAdminDemoRequest(req.id);
      if (result.invitationUrl) {
        setApprovalModal({
          requesterName: req.displayName,
          requesterEmail: req.email,
          invitationUrl: result.invitationUrl,
          expiresAt: result.expiresAt,
          isResend: true,
        });
      }
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to resend invitation');
    } finally {
      setIsModalSubmitting(false);
    }
  };

  const openRejectModal = (req: AdminDemoRequest) => {
    setRejectModal({ id: req.id, requesterName: req.displayName, requesterEmail: req.email });
    setRejectReason('');
  };

  const submitReject = async () => {
    if (!rejectModal) return;
    setIsModalSubmitting(true);
    try {
      await api.rejectAdminDemoRequest(rejectModal.id, rejectReason);
      setRejectModal(null);
      setRejectReason('');
      loadData();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to reject demo request');
    } finally {
      setIsModalSubmitting(false);
    }
  };

  const copyInvitationUrl = async () => {
    if (!approvalModal) return;
    try {
      await navigator.clipboard.writeText(approvalModal.invitationUrl);
      setCopyFeedback('copied!');
      window.setTimeout(() => setCopyFeedback(null), 1800);
    } catch {
      // Clipboard API can fail in non-HTTPS contexts or when the tab loses
      // focus mid-write. Falling back to "select-the-text-yourself" via the
      // existing readonly input below — surface the failure so the admin
      // knows to copy manually.
      setCopyFeedback('press cmd+c');
      window.setTimeout(() => setCopyFeedback(null), 2400);
    }
  };

  const pendingDemoCount = demoRequests.filter((r) => r.status === 'Pending').length;

  const formatDate = (dateStr: string) =>
    new Date(dateStr).toLocaleDateString('en-US', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });

  if (isLoading) {
    return (
      <div className="app" style={{ display: 'grid', placeItems: 'center', minHeight: '70vh' }}>
        <div className="hand" style={{ fontSize: 28, color: 'var(--purple)' }}>
          opening the backroom…
        </div>
      </div>
    );
  }

  return (
    <div className="app" style={{ position: 'relative' }}>
      {/* Purple wash background */}
      <div
        style={{ position: 'absolute', inset: -40, pointerEvents: 'none', zIndex: 0 }}
        aria-hidden="true"
      >
        <svg width="100%" height="100%" preserveAspectRatio="none">
          <rect width="100%" height="100%" fill="url(#tone-purple)" opacity="0.12" />
        </svg>
      </div>

      <div style={{ position: 'relative', zIndex: 1 }}>
        <div className="row" style={{ alignItems: 'center', gap: 16, flexWrap: 'wrap', marginBottom: 18 }}>
          <SectionTitle size={42} underline="purple">
            BACKROOM
          </SectionTitle>
          <TagSticker color="purple" rot={-4}>
            VIP
          </TagSticker>
          <TagSticker color="orange" rot={3}>
            SECRET
          </TagSticker>
          <span className="hand" style={{ fontSize: 22, color: 'var(--purple)' }}>
            shh, admins only
          </span>
          <span style={{ flex: 1 }} />
          <BackButton color="purple" onClick={() => navigate('/')}>
            back to the regular world
          </BackButton>
        </div>

        {error && (
          <div
            className="shake"
            style={{
              marginBottom: 16,
              padding: '12px 16px',
              border: '3px solid var(--ink)',
              background: 'var(--orange)',
              fontFamily: 'var(--font-body)',
              fontWeight: 700,
            }}
          >
            {error}
          </div>
        )}

        {/* Tabs */}
        <div className="row" style={{ gap: 10, marginBottom: 22, flexWrap: 'wrap' }}>
          <TabBtn active={activeTab === 'tree'} onClick={() => setActiveTab('tree')}>
            USER TREE
          </TabBtn>
          <TabBtn active={activeTab === 'users'} onClick={() => setActiveTab('users')}>
            USERS ({users.length})
          </TabBtn>
          <TabBtn active={activeTab === 'invitations'} onClick={() => setActiveTab('invitations')}>
            INVITATIONS ({invitations.length})
          </TabBtn>
          <TabBtn active={activeTab === 'demo-requests'} onClick={() => setActiveTab('demo-requests')}>
            DEMO REQUESTS ({demoRequests.length}
            {pendingDemoCount > 0 ? ` · ${pendingDemoCount} pending` : ''})
          </TabBtn>
        </div>

        {/* Content panel */}
        <ComicPanel rotate={-0.3} shadow="purple" pad={24}>
          {activeTab === 'tree' && treeData && <UserTree data={treeData.root} totalUsers={treeData.totalUsers} />}

          {activeTab === 'users' && <UserTable users={users} onRefresh={loadData} />}

          {activeTab === 'invitations' && (
            <div>
              <div className="row" style={{ marginBottom: 16, alignItems: 'baseline', gap: 12 }}>
                <SectionTitle size={26} underline="pink">
                  LEDGER
                </SectionTitle>
                <span className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)' }}>
                  page 47
                </span>
              </div>

              <div
                style={{
                  overflowX: 'auto',
                  backgroundImage:
                    'repeating-linear-gradient(0deg, transparent 0 31px, rgba(123,63,228,0.18) 31px 32px)',
                  padding: '4px 8px',
                  border: '3px solid var(--ink)',
                  borderRadius: 4,
                  background: 'var(--cream)',
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-body)' }}>
                  <thead>
                    <tr style={{ borderBottom: '3px solid var(--ink)' }}>
                      <Th>email</Th>
                      <Th>status</Th>
                      <Th>created</Th>
                      <Th>expires</Th>
                      <Th align="right">actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {invitations.map((inv) => {
                      const statusKey = inv.status.toLowerCase();
                      const color = STATUS_COLORS[statusKey] ?? { bg: 'var(--cream)', fg: 'var(--ink)' };
                      return (
                        <tr key={inv.id} style={{ borderBottom: '2px dashed rgba(26,20,23,0.15)' }}>
                          <Td>{inv.inviteeEmail}</Td>
                          <Td>
                            <span
                              style={{
                                fontFamily: 'var(--font-sfx)',
                                fontSize: 13,
                                letterSpacing: 1,
                                padding: '2px 8px',
                                background: color.bg,
                                color: color.fg,
                                border: '2px solid var(--ink)',
                                borderRadius: 4,
                                display: 'inline-block',
                              }}
                            >
                              {inv.status.toUpperCase()}
                            </span>
                          </Td>
                          <Td>{formatDate(inv.createdAt)}</Td>
                          <Td>{formatDate(inv.expiresAt)}</Td>
                          <Td align="right">
                            <button
                              type="button"
                              onClick={() => handleDeleteInvitation(inv.id)}
                              className="hand"
                              style={{
                                background: 'transparent',
                                border: '2px solid var(--ink)',
                                borderRadius: 8,
                                padding: '4px 12px',
                                fontFamily: 'var(--font-hand)',
                                fontWeight: 700,
                                fontSize: 16,
                                color: 'var(--orange-deep)',
                                cursor: 'pointer',
                              }}
                            >
                              delete
                            </button>
                          </Td>
                        </tr>
                      );
                    })}
                    {invitations.length === 0 && (
                      <tr>
                        <td colSpan={5} style={{ padding: 28, textAlign: 'center' }}>
                          <Doodle kind="envelope" size={48} color="rgba(26,20,23,0.3)" />
                          <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)', marginTop: 8 }}>
                            no invitations yet
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {activeTab === 'demo-requests' && (
            <div>
              <div className="row" style={{ marginBottom: 16, alignItems: 'baseline', gap: 12 }}>
                <SectionTitle size={26} underline="purple">
                  WAITING LIST
                </SectionTitle>
                <span className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)' }}>
                  guest sign-up requests
                </span>
              </div>

              <div
                style={{
                  overflowX: 'auto',
                  backgroundImage:
                    'repeating-linear-gradient(0deg, transparent 0 31px, rgba(123,63,228,0.18) 31px 32px)',
                  padding: '4px 8px',
                  border: '3px solid var(--ink)',
                  borderRadius: 4,
                  background: 'var(--cream)',
                }}
              >
                <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: 'var(--font-body)' }}>
                  <thead>
                    <tr style={{ borderBottom: '3px solid var(--ink)' }}>
                      <Th>name</Th>
                      <Th>email</Th>
                      <Th>message</Th>
                      <Th>status</Th>
                      <Th>submitted</Th>
                      <Th align="right">actions</Th>
                    </tr>
                  </thead>
                  <tbody>
                    {demoRequests.map((req) => {
                      const statusKey = req.status.toLowerCase();
                      const color = STATUS_COLORS[statusKey] ?? { bg: 'var(--cream)', fg: 'var(--ink)' };
                      const isPending = req.status === 'Pending';
                      return (
                        <tr key={req.id} style={{ borderBottom: '2px dashed rgba(26,20,23,0.15)' }}>
                          <Td>{req.displayName}</Td>
                          <Td>{req.email}</Td>
                          <Td>
                            <span
                              title={req.message || ''}
                              style={{
                                display: 'inline-block',
                                maxWidth: 280,
                                overflow: 'hidden',
                                textOverflow: 'ellipsis',
                                whiteSpace: 'nowrap',
                                color: req.message ? 'var(--ink)' : 'rgba(26,20,23,0.4)',
                                fontStyle: req.message ? 'normal' : 'italic',
                                verticalAlign: 'middle',
                              }}
                            >
                              {req.message || '—'}
                            </span>
                          </Td>
                          <Td>
                            <span
                              style={{
                                fontFamily: 'var(--font-sfx)',
                                fontSize: 13,
                                letterSpacing: 1,
                                padding: '2px 8px',
                                background: color.bg,
                                color: color.fg,
                                border: '2px solid var(--ink)',
                                borderRadius: 4,
                                display: 'inline-block',
                              }}
                            >
                              {req.status.toUpperCase()}
                            </span>
                          </Td>
                          <Td>{formatDate(req.submittedAt)}</Td>
                          <Td align="right">
                            {isPending ? (
                              <div style={{ display: 'inline-flex', gap: 8 }}>
                                <button
                                  type="button"
                                  onClick={() => handleApproveDemoRequest(req)}
                                  disabled={isModalSubmitting}
                                  className="hand"
                                  style={{
                                    background: 'var(--pink)',
                                    border: '2px solid var(--ink)',
                                    borderRadius: 8,
                                    padding: '4px 12px',
                                    fontFamily: 'var(--font-hand)',
                                    fontWeight: 700,
                                    fontSize: 16,
                                    color: 'var(--ink)',
                                    cursor: isModalSubmitting ? 'not-allowed' : 'pointer',
                                    boxShadow: '2px 2px 0 var(--ink)',
                                    opacity: isModalSubmitting ? 0.5 : 1,
                                  }}
                                >
                                  approve
                                </button>
                                <button
                                  type="button"
                                  onClick={() => openRejectModal(req)}
                                  disabled={isModalSubmitting}
                                  className="hand"
                                  style={{
                                    background: 'transparent',
                                    border: '2px solid var(--ink)',
                                    borderRadius: 8,
                                    padding: '4px 12px',
                                    fontFamily: 'var(--font-hand)',
                                    fontWeight: 700,
                                    fontSize: 16,
                                    color: 'var(--orange-deep)',
                                    cursor: isModalSubmitting ? 'not-allowed' : 'pointer',
                                    opacity: isModalSubmitting ? 0.5 : 1,
                                  }}
                                >
                                  reject
                                </button>
                              </div>
                            ) : req.status === 'Approved' ? (
                              <div style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                                <span className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.4)' }}>
                                  {req.reviewedAt ? formatDate(req.reviewedAt) : '—'}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => handleResendDemoRequest(req)}
                                  disabled={isModalSubmitting}
                                  className="hand"
                                  style={{
                                    background: 'transparent',
                                    border: '2px dashed var(--purple)',
                                    borderRadius: 8,
                                    padding: '3px 10px',
                                    fontFamily: 'var(--font-hand)',
                                    fontWeight: 700,
                                    fontSize: 14,
                                    color: 'var(--purple)',
                                    cursor: isModalSubmitting ? 'not-allowed' : 'pointer',
                                    opacity: isModalSubmitting ? 0.5 : 1,
                                  }}
                                  title="Generate a fresh link and re-email the requester"
                                >
                                  resend
                                </button>
                              </div>
                            ) : (
                              <span className="hand" style={{ fontSize: 14, color: 'rgba(26,20,23,0.4)' }}>
                                {req.reviewedAt ? formatDate(req.reviewedAt) : '—'}
                              </span>
                            )}
                          </Td>
                        </tr>
                      );
                    })}
                    {demoRequests.length === 0 && (
                      <tr>
                        <td colSpan={6} style={{ padding: 28, textAlign: 'center' }}>
                          <Doodle kind="envelope" size={48} color="rgba(26,20,23,0.3)" />
                          <div className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.55)', marginTop: 8 }}>
                            no demo requests yet
                          </div>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </ComicPanel>
      </div>

      {/* Approval modal — shown after approve OR resend. The invite URL is
          surfaced as a copyable input so the admin has a fallback if the
          email never lands. */}
      <Modal
        isOpen={!!approvalModal}
        onClose={() => {
          setApprovalModal(null);
          setCopyFeedback(null);
        }}
        title={approvalModal?.isResend ? 'FRESH LINK' : 'APPROVED!'}
        accent="pink"
      >
        {approvalModal && (
          <div>
            <p className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.75)', margin: '0 0 8px' }}>
              {approvalModal.isResend ? 'New link sent to' : 'Invitation sent to'}{' '}
              <strong style={{ color: 'var(--ink)' }}>{approvalModal.requesterName}</strong>{' '}
              <span style={{ color: 'rgba(26,20,23,0.5)' }}>({approvalModal.requesterEmail})</span>
            </p>
            <p className="hand" style={{ fontSize: 16, color: 'rgba(26,20,23,0.55)', margin: '0 0 14px' }}>
              if the email doesn't arrive, copy this link and send it manually:
            </p>
            <div style={{ display: 'flex', gap: 8, alignItems: 'stretch' }}>
              <input
                type="text"
                readOnly
                value={approvalModal.invitationUrl}
                onFocus={(e) => e.currentTarget.select()}
                style={{
                  flex: 1,
                  fontFamily: 'var(--font-body)',
                  fontSize: 13,
                  padding: '8px 10px',
                  border: '2px solid var(--ink)',
                  borderRadius: 4,
                  background: 'var(--cream)',
                  color: 'var(--ink)',
                  minWidth: 0,
                }}
              />
              <button
                type="button"
                onClick={copyInvitationUrl}
                className="hand"
                style={{
                  background: 'var(--pink)',
                  border: '2px solid var(--ink)',
                  borderRadius: 6,
                  padding: '4px 14px',
                  fontFamily: 'var(--font-hand)',
                  fontWeight: 700,
                  fontSize: 16,
                  color: 'var(--ink)',
                  boxShadow: '3px 3px 0 var(--ink)',
                  cursor: 'pointer',
                  whiteSpace: 'nowrap',
                }}
              >
                {copyFeedback ?? 'copy'}
              </button>
            </div>
            {approvalModal.expiresAt && (
              <p className="hand" style={{ marginTop: 12, fontSize: 14, color: 'rgba(26,20,23,0.5)' }}>
                expires {new Date(approvalModal.expiresAt).toLocaleString()}
              </p>
            )}
            <div style={{ marginTop: 22, display: 'flex', justifyContent: 'flex-end' }}>
              <StickerButton
                color="purple"
                size="md"
                onClick={() => {
                  setApprovalModal(null);
                  setCopyFeedback(null);
                }}
              >
                DONE
              </StickerButton>
            </div>
          </div>
        )}
      </Modal>

      {/* Reject modal — collects optional internal reason. The reason is
          NEVER emailed to the requester (security: avoid enumeration oracle).
          We surface that explicitly in the copy so admins don't accidentally
          write the reason expecting the requester to read it. */}
      <Modal
        isOpen={!!rejectModal}
        onClose={() => {
          if (!isModalSubmitting) {
            setRejectModal(null);
            setRejectReason('');
          }
        }}
        title="REJECT REQUEST"
        accent="orange"
      >
        {rejectModal && (
          <div>
            <p className="hand" style={{ fontSize: 18, color: 'rgba(26,20,23,0.75)', margin: '0 0 6px' }}>
              Rejecting <strong style={{ color: 'var(--ink)' }}>{rejectModal.requesterName}</strong>{' '}
              <span style={{ color: 'rgba(26,20,23,0.5)' }}>({rejectModal.requesterEmail})</span>
            </p>
            <p className="hand" style={{ fontSize: 15, color: 'rgba(26,20,23,0.55)', margin: '0 0 12px' }}>
              no email will be sent — this is just for your records.
            </p>
            <label
              className="hand"
              style={{ display: 'block', fontSize: 17, color: 'rgba(26,20,23,0.75)', marginBottom: 4 }}
            >
              reason <span style={{ color: 'rgba(26,20,23,0.4)' }}>(optional)</span>:
            </label>
            <textarea
              value={rejectReason}
              onChange={(e) => setRejectReason(e.target.value.slice(0, 300))}
              placeholder="e.g. looks like a bot, throwaway email, …"
              autoFocus
              rows={3}
              maxLength={300}
              disabled={isModalSubmitting}
              style={{
                width: '100%',
                fontFamily: 'var(--font-hand)',
                fontSize: 18,
                color: 'var(--ink)',
                background: 'transparent',
                border: '2px solid var(--ink)',
                borderRadius: 4,
                padding: '8px 10px',
                resize: 'vertical',
                outline: 'none',
                lineHeight: 1.5,
              }}
            />
            <div
              className="row"
              style={{ marginTop: 18, justifyContent: 'flex-end', gap: 12, alignItems: 'center' }}
            >
              <button
                type="button"
                onClick={() => {
                  setRejectModal(null);
                  setRejectReason('');
                }}
                disabled={isModalSubmitting}
                className="hand"
                style={{
                  background: 'transparent',
                  border: '2px solid var(--ink)',
                  borderRadius: 8,
                  padding: '6px 16px',
                  fontFamily: 'var(--font-hand)',
                  fontWeight: 700,
                  fontSize: 17,
                  color: 'var(--ink)',
                  cursor: isModalSubmitting ? 'not-allowed' : 'pointer',
                  opacity: isModalSubmitting ? 0.5 : 1,
                }}
              >
                cancel
              </button>
              <StickerButton
                color="orange"
                size="md"
                sfx="NO!"
                disabled={isModalSubmitting}
                onClick={submitReject}
              >
                {isModalSubmitting ? 'REJECTING…' : 'REJECT'}
              </StickerButton>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}

function TabBtn({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      style={{
        fontFamily: 'var(--font-sfx)',
        fontSize: 14,
        letterSpacing: 1.2,
        padding: '8px 14px',
        background: active ? 'var(--ink)' : 'var(--cream)',
        color: active ? 'var(--cream)' : 'var(--ink)',
        border: '3px solid var(--ink)',
        borderRadius: 999,
        cursor: 'pointer',
        boxShadow: active ? '3px 3px 0 var(--pink)' : '3px 3px 0 var(--ink)',
        transform: active ? 'rotate(0)' : 'rotate(-1.5deg)',
        transition: 'transform .15s, box-shadow .15s, background .15s',
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.transform = 'rotate(0) translateY(-2px)';
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.transform = 'rotate(-1.5deg)';
      }}
    >
      {children}
    </button>
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
        padding: '8px 12px',
        fontSize: 14,
        fontWeight: 600,
        color: 'var(--ink)',
      }}
    >
      {children}
    </td>
  );
}
