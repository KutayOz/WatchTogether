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
} from '../manga';
import type { AdminUser, UserTreeResponse } from '../../types';

/**
 * Two tabs, down from four. Invitations and demo requests are gone with email:
 * invites are now a single self-serve link per user, and the demo-request queue
 * had no reviewer flow left once there was nothing to email an applicant.
 *
 * The Worker also exposes GET /api/admin/audit-log, which nothing here surfaces
 * yet — deletions are recorded, just not shown.
 */
type Tab = 'tree' | 'users';

export function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [treeData, setTreeData] = useState<UserTreeResponse | null>(null);
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
      const [usersData, treeDataRes] = await Promise.all([
        api.getAdminUsers(),
        api.getAdminUserTree(),
      ]);
      setUsers(usersData);
      setTreeData(treeDataRes);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };



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
        </div>

        {/* Content panel */}
        <ComicPanel rotate={-0.3} shadow="purple" pad={24}>
          {activeTab === 'tree' && treeData && <UserTree data={treeData.root} totalUsers={treeData.totalUsers} />}

          {activeTab === 'users' && <UserTable users={users} onRefresh={loadData} />}

        </ComicPanel>
      </div>
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
