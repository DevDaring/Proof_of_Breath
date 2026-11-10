import { FormEvent, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { useSession } from '../App';
import { api, message } from '../lib/api';
import { BreathField } from '../components/Fx';

// These are public demo credentials, shown on purpose so the jury can sign in with one click.
// The account only ever reaches a private simulated sandbox.
const JURY_USER = 'DevTest';
const JURY_PASSWORD = 'DevTest11$';

function safeNext(value: string | null) {
  return value && value.startsWith('/') && !value.startsWith('//') ? value : '/';
}

export function Login() {
  const { me, loading, refresh } = useSession();
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [username, setUsername] = useState(JURY_USER);
  const [password, setPassword] = useState(JURY_PASSWORD);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const next = safeNext(params.get('next'));

  if (!loading && me) return <Navigate to={next} replace />;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api.post('/api/session/login', { username, password });
      await refresh();
      navigate(next, { replace: true });
    } catch (err) {
      setError(message(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <section className="login-intro">
        <BreathField className="login-art" cue />
        <div className="brand big"><span className="brand-dot" aria-hidden="true" />Proof of Breath</div>
        <h1>Approval by <span className="grad shimmer">breath</span>, not by reflex.</h1>
        <p>
          AI coding agents have destroyed production data, and "are you sure?" prompts stop being read. Proof of Breath holds a
          destructive command until a live person follows a breathing pattern that is different every time.
        </p>
        <p className="muted">It checks presence and attention. It is not identity authentication.</p>
      </section>
      <form className="card login-card" onSubmit={submit}>
        <h2>Sign in</h2>
        <div className="note" data-testid="jury-note">
          <strong>Jury access is filled in below.</strong> Press Sign in. You get a private sandbox: read real signals from your own camera through the Presage SDK, or use the clearly labelled simulated sensor.
        </div>
        <label>
          Username
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" data-testid="username" required />
        </label>
        <label>
          Password
          <input value={password} onChange={(e) => setPassword(e.target.value)} type="text" autoComplete="off" spellCheck={false} data-testid="password" required />
        </label>
        {error && <div className="error" role="alert" data-testid="login-error">{error}</div>}
        <button type="submit" className="btn primary wide" disabled={busy} data-testid="sign-in">{busy ? 'Signing in…' : 'Sign in'}</button>
        <div className="row between small">
          <button type="button" className="link" data-testid="fill-jury" onClick={() => { setUsername(JURY_USER); setPassword(JURY_PASSWORD); setError(''); }}>Fill jury details</button>
          <button type="button" className="link" data-testid="owner-signin" onClick={() => { setUsername(''); setPassword(''); setError(''); }}>Owner sign-in</button>
        </div>
      </form>
    </main>
  );
}
