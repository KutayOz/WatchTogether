import type { ReactNode } from 'react';
import { m } from 'motion/react';
import { NavLink, useNavigate } from 'react-router-dom';
import { useAuthContext } from '../../context/AuthContext';
import { Brand } from './Lights';
import { HomeIcon, SettingsIcon, ShieldIcon, SignOutIcon } from './icons';
import { ease, spring } from './motion';
import { useScene } from './useScene';

interface AppShellProps {
  children: ReactNode;
  className?: string;
}

/**
 * The frame for signed-in pages outside a call: the mark on the left, where
 * you can go on the right, and the page arriving underneath in focus.
 */
export function AppShell({ children, className }: AppShellProps) {
  useScene('app');
  const { user, logout } = useAuthContext();
  const navigate = useNavigate();

  const signOut = () => {
    logout();
    navigate('/login');
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <Brand />
        <nav className="topbar__nav" aria-label="Main">
          <ShellLink to="/" end icon={<HomeIcon size={18} />} label="Lobby" />
          <ShellLink to="/settings" icon={<SettingsIcon size={18} />} label="Settings" />
          {user?.isRootUser && <ShellLink to="/admin" icon={<ShieldIcon size={18} />} label="Admin" />}
          <button type="button" className="nav-link" onClick={signOut} data-light="">
            <SignOutIcon size={18} />
            <span className="nav-link__label">Sign out</span>
          </button>
        </nav>
        {user && (
          <span className="topbar__me" title={user.tag}>
            <span className="avatar" style={{ ['--av' as string]: '32px' }} aria-hidden="true">
              {user.username.charAt(0).toUpperCase()}
            </span>
            <span className="topbar__tag">{user.tag}</span>
          </span>
        )}
      </header>

      <m.main
        className={['app-main', className].filter(Boolean).join(' ')}
        initial={{ opacity: 0, filter: 'blur(8px)' }}
        animate={{ opacity: 1, filter: 'blur(0px)' }}
        transition={{ duration: 0.6, ease: ease.out }}
      >
        {children}
      </m.main>
    </div>
  );
}

function ShellLink({ to, icon, label, end }: { to: string; icon: ReactNode; label: string; end?: boolean }) {
  return (
    <NavLink to={to} end={end} className="nav-link" data-light="">
      {({ isActive }) => (
        <>
          {isActive && (
            <m.span layoutId="nav-active" className="nav-link__pill" transition={spring.snappy} aria-hidden="true" />
          )}
          {icon}
          <span className="nav-link__label">{label}</span>
        </>
      )}
    </NavLink>
  );
}
