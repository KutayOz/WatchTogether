import { useState, lazy, Suspense } from 'react';
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, useAuthContext } from './context/AuthContext';
import { SessionProvider } from './context/SessionContext';
import { BrowserWarning } from './components/BrowserWarning';
import {
  getCompatibilityWarnings,
  detectBrowser,
  hasUserDismissedWarning,
  dismissWarning,
} from './utils/browserDetection';
import { ScreentoneDefs } from './components/manga';

/*
 * Route-level code splitting.
 *
 * Why: a single static-import App.tsx was producing a 556 kB / 155 kB-gzip
 * main chunk that every visitor downloaded before even seeing /login. Each
 * route here lives behind a dynamic import so Vite emits a per-route chunk;
 * pair with the manualChunks config in vite.config.ts (which groups vendor
 * deps like react / webrtc-adapter separately) and a typical first load is now
 * <App + react-vendor + auth> — the session-only deps (webrtc-adapter,
 * useWebRTC, useTransport) don't ship until the user actually enters a call.
 *
 * Grouping policy: we don't use one `lazy()` per file — Auth screens travel
 * together because users that hit /login often follow up with /register, and
 * we'd rather one bigger chunk that's then cached than five tiny ones.
 * Vite's manualChunks (in vite.config.ts) does the actual grouping by path;
 * the lazy() call just makes the import dynamic.
 */
const Login = lazy(() => import('./components/Login/Login').then((m) => ({ default: m.Login })));
const InviteSignup = lazy(() => import('./components/Auth/InviteSignup').then((m) => ({ default: m.InviteSignup })));
const Lobby = lazy(() => import('./components/Lobby/Lobby').then((m) => ({ default: m.Lobby })));
const SessionRoom = lazy(() => import('./components/Session/SessionRoom').then((m) => ({ default: m.SessionRoom })));
const JoinSession = lazy(() => import('./components/Session/JoinSession').then((m) => ({ default: m.JoinSession })));
const AdminDashboard = lazy(() => import('./components/Admin/AdminDashboard').then((m) => ({ default: m.AdminDashboard })));
const Settings = lazy(() => import('./components/Settings/Settings').then((m) => ({ default: m.Settings })));
// Lazy for the same reason as the routes, and load-bearing beyond that: a
// static import from here would pull the whole `auth` chunk into the main
// bundle, which is exactly the inlining the manualChunks comment in
// vite.config.ts warns about.
const TermsModal = lazy(() => import('./components/Auth/TermsModal').then((m) => ({ default: m.TermsModal })));

/**
 * Suspense fallback used while a route chunk is downloading. The visible delay
 * on a warm cache is usually 0 ms; on a cold cache + 4G this is what the user
 * sees for ~200-400 ms. It mirrors the sketchbook aesthetic so a brief flash
 * looks intentional (a loading state in the comic), not broken.
 *
 * `inset: 0` + grid place-items keeps the dots centered regardless of where
 * the route ends up rendering — Auth pages center themselves, SessionRoom
 * fills the viewport, both look right.
 */
function RouteLoader() {
  return (
    <div
      role="status"
      aria-label="loading"
      style={{
        position: 'fixed',
        inset: 0,
        display: 'grid',
        placeItems: 'center',
        background: 'var(--cream, #fdf6e7)',
        zIndex: 9999,
      }}
    >
      <div className="hand" style={{ fontSize: 28, color: 'var(--purple, #6b46c1)', letterSpacing: 2 }}>
        loading
        <span style={{ display: 'inline-block', animation: 'routeDot 1.2s infinite', animationDelay: '0s' }}>.</span>
        <span style={{ display: 'inline-block', animation: 'routeDot 1.2s infinite', animationDelay: '0.2s' }}>.</span>
        <span style={{ display: 'inline-block', animation: 'routeDot 1.2s infinite', animationDelay: '0.4s' }}>.</span>
      </div>
      {/* Inlined so the loader works even before the main stylesheet has fully
          applied — the route loader is in the critical path. */}
      <style>{`
        @keyframes routeDot {
          0%, 80%, 100% { opacity: 0.2; transform: translateY(0); }
          40% { opacity: 1; transform: translateY(-4px); }
        }
      `}</style>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthContext();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  return <>{children}</>;
}

function AdminRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthContext();
  if (!user) {
    return <Navigate to="/login" replace />;
  }
  if (!user.isRootUser) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { user } = useAuthContext();
  if (user) {
    return <Navigate to="/" replace />;
  }
  return <>{children}</>;
}

/**
 * The House Rules gate.
 *
 * It lives here rather than inside Login and InviteSignup because acceptance
 * has to hold for every way into the app, not just the two screens that create
 * accounts. It used to be a `showTermsModal` flag on each of those, and the
 * Login copy could never render at all: PublicRoute sends an authenticated user
 * to "/" the moment sign-in populates the user, which unmounts Login before its
 * own modal gets a frame. So the only people who ever saw the gate were brand
 * new invitees — /invite/:token is the one route with no PublicRoute around it.
 *
 * That made the version bump documented in worker/src/routes/terms.ts ("raising
 * it re-prompts everyone") untrue: a returning user with a valid session gets
 * hasAcceptedTerms=false back from /me and then walks straight into the app,
 * because they never pass through a screen that was watching for it.
 *
 * The gate replaces the route tree rather than floating over it. As an overlay
 * it would leave the Lobby's buttons reachable behind the backdrop by keyboard,
 * and a prompt you can tab around is not a gate. Nothing navigates on accept —
 * the routes simply come back, so a user re-prompted at /join/:token keeps the
 * link they arrived on.
 */
function TermsGate({ children }: { children: React.ReactNode }) {
  const { user, updateTermsAccepted } = useAuthContext();
  if (!user || user.hasAcceptedTerms) {
    return <>{children}</>;
  }
  return <TermsModal isOpen onAccept={updateTermsAccepted} />;
}

function AppRoutes() {
  return (
    <Routes>
      {/* The only way to create an account. /register, /verify-email,
          /check-email and /request-demo are gone with passwords and email —
          any stale bookmark falls through to the catch-all below. */}
      <Route path="/invite/:token" element={<InviteSignup />} />

      {/* Login */}
      <Route
        path="/login"
        element={
          <PublicRoute>
            <Login />
          </PublicRoute>
        }
      />

      {/* Protected routes */}
      <Route
        path="/"
        element={
          <ProtectedRoute>
            <Lobby />
          </ProtectedRoute>
        }
      />
      <Route
        path="/session/:id"
        element={
          <ProtectedRoute>
            <SessionRoom />
          </ProtectedRoute>
        }
      />
      <Route
        path="/join/:token"
        element={<JoinSession />}
      />
      <Route
        path="/settings"
        element={
          <ProtectedRoute>
            <Settings />
          </ProtectedRoute>
        }
      />

      {/* Admin route */}
      <Route
        path="/admin"
        element={
          <AdminRoute>
            <AdminDashboard />
          </AdminRoute>
        }
      />

      {/* Catch-all */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

function App() {
  const [browserWarning, setBrowserWarning] = useState<{
    type: 'blocking' | 'dismissible';
    message: string;
  } | null>(() => {
    const { blocking, warnings } = getCompatibilityWarnings();
    const browser = detectBrowser();
    if (blocking) return { type: 'blocking', message: blocking };
    if (warnings.length > 0 && !hasUserDismissedWarning(browser.name)) {
      return { type: 'dismissible', message: warnings[0] };
    }
    return null;
  });

  const handleDismissWarning = () => {
    const browser = detectBrowser();
    dismissWarning(browser.name);
    setBrowserWarning(null);
  };

  return (
    <BrowserRouter>
      {/* Screentone SVG <defs> — referenced by fill="url(#tone-…)" across the app */}
      <ScreentoneDefs />
      {browserWarning && (
        <BrowserWarning
          type={browserWarning.type}
          message={browserWarning.message}
          onDismiss={browserWarning.type === 'dismissible' ? handleDismissWarning : undefined}
        />
      )}
      <AuthProvider>
        <SessionProvider>
          {/* Suspense wraps the whole route tree because *every* route is
              lazy now. The fallback only shows while a chunk is in flight —
              warm cache = invisible, cold = manga-styled loader. */}
          <Suspense fallback={<RouteLoader />}>
            <TermsGate>
              <AppRoutes />
            </TermsGate>
          </Suspense>
        </SessionProvider>
      </AuthProvider>
    </BrowserRouter>
  );
}

export default App;
