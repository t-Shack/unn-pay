import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice } from '../components/ui';

export default function Login() {
  const { signIn } = useAuth();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await signIn(email.trim(), password);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="login">
      <div className="login__card">
        <div className="login__brand">
          <strong>UNIVERSITY OF NIGERIA, NSUKKA</strong>
          <span>UNN Pay · Bursary Dashboard</span>
        </div>

        <div className="card">
          <div className="card__body">
            <h1 style={{ marginBottom: 14, fontSize: 18 }}>Sign in</h1>
            <ErrorNotice error={error} />

            <form onSubmit={submit}>
              <div className="field">
                <label htmlFor="email">Staff email address</label>
                <input
                  id="email"
                  type="email"
                  autoComplete="username"
                  required
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@unn.edu.ng"
                />
              </div>

              <div className="field">
                <label htmlFor="password">Password</label>
                <input
                  id="password"
                  type="password"
                  autoComplete="current-password"
                  required
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                />
              </div>

              <button className="btn btn--primary" style={{ width: '100%' }} disabled={busy}>
                {busy ? <span className="spinner" /> : 'Sign in'}
              </button>
            </form>

            <p className="small muted" style={{ marginTop: 14 }}>
              Accounts are created by a Super Admin. There is no public registration.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}
