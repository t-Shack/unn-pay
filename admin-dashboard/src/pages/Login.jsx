import { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { ErrorNotice } from '../components/ui';
import { ArrowIcon } from '../components/icons';

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
      <section className="login__hero">
        <span className="ring" aria-hidden="true" />
        <span className="ring ring--thin" aria-hidden="true" />

        <div className="login__brand">
          <span className="brand-mark" aria-hidden="true">
            U
          </span>
          <div>
            <strong>UNN Pay</strong>
            <span>University of Nigeria, Nsukka</span>
          </div>
        </div>

        <div className="login__headline">
          <h1>
            Every naira, <em>accounted for.</em>
          </h1>
          <p>
            Collections, reconciliation and the unapplied payments queue for the Bursary
            Department, in one place.
          </p>
        </div>
      </section>

      <section className="login__panel">
        <div className="login__card">
          <h2>Sign in</h2>
          <p className="muted" style={{ marginBottom: 22 }}>
            Bursary staff only. Use your University email.
          </p>

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

            <button
              className="btn btn--primary"
              style={{ width: '100%', minHeight: 52, marginTop: 6 }}
              disabled={busy}
            >
              {busy ? (
                <span className="spinner" />
              ) : (
                <>
                  Sign in <ArrowIcon size={18} />
                </>
              )}
            </button>
          </form>

          <p className="small muted" style={{ marginTop: 16 }}>
            Accounts are created by a Super Admin. There is no public registration.
          </p>
        </div>
      </section>
    </div>
  );
}
