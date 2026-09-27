import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { AnimatePresence, m } from 'motion/react';
import { useAuthContext } from '../../context/AuthContext';
import { api } from '../../services/api';
import { UserTree } from './UserTree';
import { UserTable } from './UserTable';
import { DemoRequests } from './DemoRequests';
import { AppShell } from '../ui/AppShell';
import { AlertIcon, InboxIcon, TreeIcon, UsersIcon } from '../ui/icons';
import { ease, spring } from '../ui/motion';
import type { AdminDemoRequest, AdminUser, UserTreeResponse } from '../../types';
import './admin.css';

/**
 * Three tabs. The invitations tab stays gone — invites are a single self-serve
 * link per user now, minted from the lobby — but the demo-request queue is back,
 * on different terms: reviewing it produces an invite link for root to pass on
 * by hand, where the old flow ended in an email nothing here can send.
 *
 * The Worker also exposes GET /api/admin/audit-log, which nothing here surfaces
 * yet — deletions and demo-request decisions are recorded, just not shown.
 */
type Tab = 'tree' | 'users' | 'demo';

export function AdminDashboard() {
  const navigate = useNavigate();
  const { user } = useAuthContext();
  const [activeTab, setActiveTab] = useState<Tab>('tree');
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [treeData, setTreeData] = useState<UserTreeResponse | null>(null);
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
      const [usersData, treeDataRes, demoData] = await Promise.all([
        api.getAdminUsers(),
        api.getAdminUserTree(),
        api.getAdminDemoRequests(),
      ]);
      setUsers(usersData);
      setTreeData(treeDataRes);
      setDemoRequests(demoData);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to load data');
    } finally {
      setIsLoading(false);
    }
  };

  // The count is the pending ones — a dealt-with request is not a thing
  // anybody needs to be nudged about.
  const pending = demoRequests.filter((r) => r.status === 'pending').length;

  const tabs: Array<{ id: Tab; label: string; count?: number; icon: React.ReactNode }> = [
    { id: 'tree', label: 'Invite tree', icon: <TreeIcon size={18} /> },
    { id: 'users', label: 'People', count: users.length, icon: <UsersIcon size={18} /> },
    { id: 'demo', label: 'Requests', count: pending, icon: <InboxIcon size={18} /> },
  ];

  return (
    <AppShell>
      <header className="page-head">
        <div>
          <h1>Admin</h1>
          <p className="page-head__sub">Who’s here, who invited whom, and who’s asking to join.</p>
        </div>
      </header>

      {error && (
        <div className="notice notice--error" role="alert" style={{ marginBottom: 18 }}>
          <AlertIcon size={18} />
          <span>{error}</span>
        </div>
      )}

      <div className="admin-tabs" role="tablist" aria-label="Admin sections">
        {tabs.map((tab) => {
          const active = tab.id === activeTab;
          return (
            <button
              key={tab.id}
              type="button"
              role="tab"
              id={`tab-${tab.id}`}
              aria-selected={active}
              aria-controls={`panel-${tab.id}`}
              className="admin-tab"
              data-light=""
              onClick={() => setActiveTab(tab.id)}
            >
              {active && (
                <m.span layoutId="admin-tab" className="admin-tab__pill" transition={spring.snappy} aria-hidden="true" />
              )}
              {tab.icon}
              <span>{tab.label}</span>
              {tab.count !== undefined && !isLoading && (
                <span className="admin-tab__count tabular" data-hot={tab.id === 'demo' && tab.count > 0 ? '' : undefined}>
                  {tab.count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <section
        className="card admin-panel"
        role="tabpanel"
        id={`panel-${activeTab}`}
        aria-labelledby={`tab-${activeTab}`}
      >
        {isLoading ? (
          <div className="admin-loading" role="status">
            <span className="btn__spinner" aria-hidden="true" />
            Loading…
          </div>
        ) : (
          <AnimatePresence mode="wait" initial={false}>
            <m.div
              key={activeTab}
              initial={{ opacity: 0, y: 10, filter: 'blur(4px)' }}
              animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
              exit={{ opacity: 0, y: -6, filter: 'blur(2px)', transition: { duration: 0.14 } }}
              transition={{ duration: 0.35, ease: ease.out }}
            >
              {activeTab === 'tree' && (
                <UserTree data={treeData?.root ?? null} totalUsers={treeData?.totalUsers ?? 0} />
              )}
              {activeTab === 'users' && <UserTable users={users} onRefresh={loadData} />}
              {activeTab === 'demo' && <DemoRequests requests={demoRequests} onRefresh={loadData} />}
            </m.div>
          </AnimatePresence>
        )}
      </section>
    </AppShell>
  );
}
