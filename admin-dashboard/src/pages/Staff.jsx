import { useState } from 'react';
import { api } from '../api/client';
import { ErrorNotice, Notice } from '../components/ui';

/**
 * Staff accounts (§7.7, §11.6).
 *
 * Super Admin only, and reachable nowhere else: there is no public admin
 * registration endpoint anywhere in this system. The very first Super Admin is
 * created with a CLI script on the server.
 */

const BLANK = {
  staff_id: '',
  full_name: '',
  email: '',
  password: '',
  role: 'Bursary Staff',
};

export default function Staff() {
  const [form, setForm] = useState(BLANK);
  const [error, setError] = useState(null);
  const [created, setCreated] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setCreated(null);
    setBusy(true);
    try {
      const response = await api.staff.create({ ...form, email: form.email.trim().toLowerCase() });
      setCreated(response.admin);
      setForm(BLANK);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Staff</h1>
          <div className="topbar__sub">Create Bursary accounts. Super Admin only.</div>
        </div>
      </div>

      <div className="content">
        <ErrorNotice error={error} />

        {created && (
          <Notice kind="good">
            Created {created.full_name} ({created.email}) as {created.role}. Give them the
            password you set through a channel other than email, and ask them to change it.
          </Notice>
        )}

        <section className="card" style={{ maxWidth: 620 }}>
          <div className="card__head">
            <h2>New staff account</h2>
          </div>
          <div className="card__body">
            <form onSubmit={submit}>
              <div className="filters">
                <div className="field">
                  <label htmlFor="staff_id">Staff ID</label>
                  <input
                    id="staff_id"
                    required
                    maxLength={50}
                    value={form.staff_id}
                    onChange={update('staff_id')}
                    placeholder="BUR014"
                  />
                </div>

                <div className="field">
                  <label htmlFor="role">Role</label>
                  <select id="role" value={form.role} onChange={update('role')}>
                    <option value="Bursary Staff">Bursary Staff</option>
                    <option value="Super Admin">Super Admin</option>
                  </select>
                </div>
              </div>

              <div className="field">
                <label htmlFor="full_name">Full name</label>
                <input
                  id="full_name"
                  required
                  maxLength={100}
                  value={form.full_name}
                  onChange={update('full_name')}
                />
              </div>

              <div className="field">
                <label htmlFor="email">Email address</label>
                <input
                  id="email"
                  type="email"
                  required
                  maxLength={100}
                  value={form.email}
                  onChange={update('email')}
                  placeholder="name@unn.edu.ng"
                />
              </div>

              <div className="field">
                <label htmlFor="password">Initial password</label>
                <input
                  id="password"
                  type="text"
                  required
                  minLength={12}
                  value={form.password}
                  onChange={update('password')}
                  autoComplete="new-password"
                />
                <div className="small muted" style={{ marginTop: 4 }}>
                  At least 12 characters, with an uppercase letter, a lowercase letter and a
                  number. Shown as plain text so you can read it out; it is stored hashed.
                </div>
              </div>

              <div className="row row--end">
                <button className="btn btn--primary" disabled={busy}>
                  {busy ? <span className="spinner" /> : 'Create account'}
                </button>
              </div>
            </form>
          </div>
        </section>

        <section className="card" style={{ maxWidth: 620, marginTop: 18 }}>
          <div className="card__head">
            <h2>Roles</h2>
          </div>
          <div className="card__body small">
            <p style={{ marginBottom: 8 }}>
              <strong>Bursary Staff</strong> — everything except creating other accounts:
              transactions, exports, the unapplied queue, fee items and student import.
            </p>
            <p>
              <strong>Super Admin</strong> — all of the above, plus creating staff accounts.
            </p>
          </div>
        </section>
      </div>
    </>
  );
}
