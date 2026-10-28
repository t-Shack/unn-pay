import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { ErrorNotice, Loading, Notice, formatWat } from '../components/ui';

/**
 * Student import (§11.6).
 *
 * Two steps, always, and the interface makes the separation obvious: upload
 * validates and shows exactly what will happen, and nothing is written until the
 * admin confirms. A half imported student list during registration week is a
 * disaster, so there is no single click path that could produce one.
 */

const TEMPLATE = [
  'matric_number,full_name,email,department,level,phone',
  '2022/248400,Chidera Okonkwo,chidera.okonkwo@unn.edu.ng,Computer Science,400,08030000001',
  '2023/119872,Emeka Eze,emeka.eze@unn.edu.ng,Computer Science,300,08030000002',
].join('\n');

export default function StudentImport() {
  const [file, setFile] = useState(null);
  const [session, setSession] = useState(currentSession());
  const [preview, setPreview] = useState(null);
  const [committed, setCommitted] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [allowPartial, setAllowPartial] = useState(false);

  const loadHistory = () =>
    api.students
      .imports()
      .then((result) => setHistory(result.items))
      .catch(() => setHistory([]));

  useEffect(() => {
    loadHistory();
  }, []);

  const upload = async (event) => {
    event.preventDefault();
    if (!file) return;

    setError(null);
    setCommitted(null);
    setPreview(null);
    setAllowPartial(false);
    setBusy(true);

    try {
      setPreview(await api.students.preview(file, session));
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const commit = async () => {
    setError(null);
    setBusy(true);
    try {
      const result = await api.students.commit(preview.import_id, allowPartial);
      setCommitted(result);
      setPreview(null);
      setFile(null);
      loadHistory();
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  const downloadTemplate = () => {
    const blob = new Blob([TEMPLATE], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'unn-pay-student-template.csv';
    link.click();
    URL.revokeObjectURL(url);
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Student import</h1>
          <div className="topbar__sub">
            Nothing is written until you confirm what the file will do
          </div>
        </div>
        <button className="btn" onClick={downloadTemplate}>
          Download template
        </button>
      </div>

      <div className="content">
        <ErrorNotice error={error} />

        {committed && (
          <Notice kind="good">
            Import complete. {committed.created} student
            {committed.created === 1 ? '' : 's'} added, {committed.updated} updated
            {committed.failure_count > 0 && `, ${committed.failure_count} skipped as invalid`}.
            Imported students must activate their own accounts before they can sign in.
          </Notice>
        )}

        {!preview && (
          <section className="card" style={{ marginBottom: 18 }}>
            <div className="card__head">
              <h2>Step 1 — Upload and check</h2>
            </div>
            <div className="card__body">
              <form onSubmit={upload}>
                <div className="filters" style={{ marginBottom: 12 }}>
                  <div className="field field--inline">
                    <label htmlFor="session">Session</label>
                    <input
                      id="session"
                      required
                      pattern="^\d{4}/\d{4}$"
                      value={session}
                      onChange={(event) => setSession(event.target.value)}
                      placeholder="2025/2026"
                    />
                  </div>
                  <div className="field field--inline" style={{ gridColumn: 'span 2' }}>
                    <label htmlFor="file">CSV file</label>
                    <input
                      id="file"
                      type="file"
                      accept=".csv,text/csv"
                      required
                      onChange={(event) => setFile(event.target.files[0] || null)}
                    />
                  </div>
                </div>

                <div className="row row--between">
                  <p className="small muted" style={{ maxWidth: 520 }}>
                    Required columns: matric_number, full_name, email, department, level.
                    phone is optional. Matric numbers must look like 2022/248400.
                  </p>
                  <button className="btn btn--primary" disabled={busy || !file}>
                    {busy ? <span className="spinner" /> : 'Check file'}
                  </button>
                </div>
              </form>
            </div>
          </section>
        )}

        {preview && (
          <section className="card" style={{ marginBottom: 18 }}>
            <div className="card__head">
              <h2>Step 2 — Confirm</h2>
              <span className="badge badge--pending">Nothing written yet</span>
            </div>
            <div className="card__body">
              <div className="grid grid--4" style={{ marginBottom: 16 }}>
                <div className="stat" style={{ padding: 0 }}>
                  <div className="stat__label">Rows in file</div>
                  <div className="stat__value">{preview.row_count}</div>
                </div>
                <div className="stat stat--good" style={{ padding: 0 }}>
                  <div className="stat__label">Will be created</div>
                  <div className="stat__value">{preview.will_create}</div>
                </div>
                <div className="stat" style={{ padding: 0 }}>
                  <div className="stat__label">Will be updated</div>
                  <div className="stat__value">{preview.will_update}</div>
                </div>
                <div
                  className={`stat ${preview.failure_count > 0 ? 'stat--bad' : ''}`}
                  style={{ padding: 0 }}
                >
                  <div className="stat__label">Invalid rows</div>
                  <div className="stat__value">{preview.failure_count}</div>
                </div>
              </div>

              {preview.failure_count > 0 && (
                <>
                  <Notice kind="warn">
                    This file has {preview.failure_count} row
                    {preview.failure_count === 1 ? '' : 's'} that cannot be imported. Fix the file
                    and upload it again, or import only the valid rows.
                  </Notice>

                  <div className="table-wrap" style={{ maxHeight: 300, overflowY: 'auto' }}>
                    <table>
                      <thead>
                        <tr>
                          <th>Row</th>
                          <th>Matric number</th>
                          <th>Problem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.errors.map((row) => (
                          <tr key={row.row}>
                            <td className="num">{row.row}</td>
                            <td className="mono small">{row.matric_number || '—'}</td>
                            <td className="small">{row.errors.join('; ')}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <label className="row" style={{ marginTop: 12, gap: 8 }}>
                    <input
                      type="checkbox"
                      style={{ width: 'auto' }}
                      checked={allowPartial}
                      onChange={(event) => setAllowPartial(event.target.checked)}
                    />
                    <span className="small">
                      Import the {preview.will_create + preview.will_update} valid row
                      {preview.will_create + preview.will_update === 1 ? '' : 's'} and skip the
                      invalid ones
                    </span>
                  </label>
                </>
              )}

              {preview.sample && preview.sample.length > 0 && (
                <>
                  <h3 style={{ margin: '16px 0 8px' }}>
                    First {preview.sample.length} student{preview.sample.length === 1 ? '' : 's'} to
                    be created
                  </h3>
                  <div className="table-wrap">
                    <table>
                      <thead>
                        <tr>
                          <th>Matric number</th>
                          <th>Name</th>
                          <th>Email</th>
                          <th>Department</th>
                          <th>Level</th>
                        </tr>
                      </thead>
                      <tbody>
                        {preview.sample.map((row) => (
                          <tr key={row.matric_number}>
                            <td className="mono small">{row.matric_number}</td>
                            <td>{row.full_name}</td>
                            <td className="small">{row.email}</td>
                            <td className="small">{row.department}</td>
                            <td className="small">{row.level}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </>
              )}

              <div className="row row--end" style={{ marginTop: 16 }}>
                <button
                  className="btn"
                  disabled={busy}
                  onClick={() => {
                    setPreview(null);
                    setFile(null);
                  }}
                >
                  Cancel
                </button>
                <button
                  className="btn btn--primary"
                  disabled={busy || (preview.failure_count > 0 && !allowPartial)}
                  onClick={commit}
                >
                  {busy ? (
                    <span className="spinner" />
                  ) : (
                    `Import ${preview.will_create + preview.will_update} student${
                      preview.will_create + preview.will_update === 1 ? '' : 's'
                    }`
                  )}
                </button>
              </div>
            </div>
          </section>
        )}

        <section className="card">
          <div className="card__head">
            <h2>Previous imports</h2>
          </div>
          {!history ? (
            <Loading />
          ) : history.length === 0 ? (
            <div className="card__body muted small">No imports yet.</div>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>File</th>
                    <th>Session</th>
                    <th className="num">Rows</th>
                    <th className="num">Imported</th>
                    <th className="num">Invalid</th>
                    <th>Status</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {history.map((row) => (
                    <tr key={row.import_id}>
                      <td>{row.filename}</td>
                      <td className="small nowrap">{row.session}</td>
                      <td className="num">{row.row_count}</td>
                      <td className="num">{row.success_count}</td>
                      <td className="num">{row.failure_count}</td>
                      <td>
                        <span
                          className={`badge badge--${
                            row.status === 'committed' ? 'success' : 'neutral'
                          }`}
                        >
                          {row.status}
                        </span>
                      </td>
                      <td className="nowrap small">{formatWat(row.created_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </>
  );
}

function currentSession() {
  const now = new Date();
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}/${startYear + 1}`;
}
