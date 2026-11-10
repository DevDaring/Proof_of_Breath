import { Component, createContext, ReactNode, useCallback, useContext, useEffect, useState } from 'react';
import { Link, Navigate, NavLink, Route, Routes, useLocation, useNavigate } from 'react-router-dom';
import { Aurora, useSpotlight } from './components/Fx';
import { api, Me } from './lib/api';
import { Spinner, ToastProvider } from './components/ui';
import { Login } from './pages/Login';
import { Onboarding } from './pages/Onboarding';
import { Home } from './pages/Home';
import { Gate } from './pages/Gate';
import { Receipts } from './pages/Receipts';
import { Rules } from './pages/Rules';
import { Evaluation } from './pages/Evaluation';
import { SettingsPage } from './pages/Settings';
import { Measure } from './pages/Measure';
import { CaseStudy } from './pages/CaseStudy';

interface Session { me: Me | null; loading: boolean; refresh: () => Promise<Me | null>; signOut: () => Promise<void> }
const SessionContext = createContext<Session>({ me: null, loading: true, refresh: async () => null, signOut: async () => undefined });
export const useSession = () => useContext(SessionContext);

class Boundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  render() {
    if (this.state.failed) {
      return (
        <div className="page narrow">
          <h1>Something went wrong</h1>
          <p className="muted">This page hit an unexpected error. Your data is safe.</p>
          <button type="button" className="btn primary" onClick={() => location.assign('/')}>Back to overview</button>
        </div>
      );
    }
    return this.props.children;
  }
}

function RequireAuth({ children }: { children: ReactNode }) {
  const { me, loading } = useSession();
  const location = useLocation();
  if (loading) return <Spinner />;
  if (!me) return <Navigate to={`/login?next=${encodeURIComponent(location.pathname + location.search)}`} replace />;
  return <>{children}</>;
}

function RequireOnboarded({ children }: { children: ReactNode }) {
  const { me } = useSession();
  if (me && !me.consents.includes('gate')) return <Navigate to="/onboarding" replace />;
  return <>{children}</>;
}

function Shell({ children }: { children: ReactNode }) {
  const { me, signOut } = useSession();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => setOpen(false), [location.pathname]);
  return (
    <>
      <header className="topbar">
        <Link to="/" className="brand"><span className="brand-dot" aria-hidden="true" />Proof of Breath</Link>
        <button type="button" className="menu-btn" aria-expanded={open} aria-label="Menu" onClick={() => setOpen((v) => !v)} data-testid="menu">☰</button>
        <nav className={open ? 'open' : ''}>
          <NavLink to="/" end>Overview</NavLink>
          <NavLink to="/measure" data-testid="nav-measure">Live reading</NavLink>
          <NavLink to="/case-study" data-testid="nav-case">Case study</NavLink>
          <NavLink to="/receipts">Receipts</NavLink>
          <NavLink to="/rules">Rules</NavLink>
          <NavLink to="/evaluation">Evaluation</NavLink>
          <NavLink to="/settings">Settings</NavLink>
          <span className="who">
            <span className={`pill ${me?.role === 'owner' ? 'live' : 'sim'}`}>{me?.role === 'owner' ? 'Owner' : 'Jury sandbox'}</span>
            <button type="button" className="link" data-testid="sign-out" onClick={async () => { await signOut(); navigate('/login'); }}>Sign out</button>
          </span>
        </nav>
      </header>
      {me?.role === 'jury' && (
        <div className="banner" data-testid="sim-banner">Private jury sandbox. Use your own camera for a real SDK reading, or the simulated sensor. Nothing here can approve a real command.</div>
      )}
      {children}
    </>
  );
}

function NotFound() {
  return (
    <div className="page narrow">
      <h1>Page not found</h1>
      <Link className="btn primary" to="/">Back to overview</Link>
    </div>
  );
}

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [loading, setLoading] = useState(true);
  useSpotlight();

  const refresh = useCallback(async () => {
    try {
      const next = await fetch('/api/session', { credentials: 'same-origin' });
      const data = next.ok ? ((await next.json()) as Me) : null;
      setMe(data);
      return data;
    } catch {
      setMe(null);
      return null;
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const signOut = useCallback(async () => {
    await api.post('/api/session/logout').catch(() => undefined);
    setMe(null);
  }, []);

  const inShell = (node: ReactNode, onboarded = true) => (
    <RequireAuth>
      <Shell>{onboarded ? <RequireOnboarded>{node}</RequireOnboarded> : node}</Shell>
    </RequireAuth>
  );

  return (
    <SessionContext.Provider value={{ me, loading, refresh, signOut }}>
      <ToastProvider>
        <Aurora />
        <Boundary>
          <Routes>
            <Route path="/login" element={<Login />} />
            <Route path="/onboarding" element={inShell(<Onboarding />, false)} />
            <Route path="/" element={inShell(<Home />)} />
            <Route path="/gate/:requestId" element={inShell(<Gate />, false)} />
            <Route path="/measure" element={inShell(<Measure />)} />
            <Route path="/case-study" element={inShell(<CaseStudy />)} />
            <Route path="/receipts" element={inShell(<Receipts />)} />
            <Route path="/rules" element={inShell(<Rules />)} />
            <Route path="/evaluation" element={inShell(<Evaluation />)} />
            <Route path="/settings" element={inShell(<SettingsPage />, false)} />
            <Route path="*" element={inShell(<NotFound />, false)} />
          </Routes>
        </Boundary>
      </ToastProvider>
    </SessionContext.Provider>
  );
}
