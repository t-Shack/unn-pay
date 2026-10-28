import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
  formatNaira,
} from '../components/ui';

/**
 * Fee items (§11.6, §7.3).
 *
 * Two rules the interface has to make visible:
 *  - amounts here are authoritative; a client never sends one
 *  - deletion is soft only, and editing a price never changes an amount already
 *    quoted to a student, because transactions snapshot it at mint time
 */

const CATEGORIES = ['Tuition', 'Acceptance', 'Departmental', 'Hostel', 'Other'];

const BLANK = {
  name: '',
  category: 'Tuition',
  amount: '',
  department: '',
  level: '',
  session: '',
};

export default function FeeItems() {
  const [items, setItems] = useState(null);
  const [includeInactive, setIncludeInactive] = useState(false);
  const [error, setError] = useState(null);
  const [editing, setEditing] = useState(null);
  const [notice, setNotice] = useState(null);

  const load = useCallback(() => {
    api.feeItems
      .list({ include_inactive: includeInactive ? 'true' : undefined })
      .then((result) => {
        setItems(result.items);
        setError(null);
      })
      .catch(setError);
  }, [includeInactive]);

  useEffect(load, [load]);

  const deactivate = async (item) => {
    const confirmed = window.confirm(
      `Deactivate "${item.name}"?\n\nIt will stop being offered to students. ` +
        'Existing payments and references are untouched, and the record is kept.'
    );
    if (!confirmed) return;

    try {
      await api.feeItems.deactivate(item.fee_item_id);
      setNotice(`"${item.name}" has been deactivated.`);
      load();
    } catch (caught) {
      setError(caught);
    }
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Fee items</h1>
          <div className="topbar__sub">Amounts are set here and never accepted from a client</div>
        </div>
        <div className="row">
          <label className="row" style={{ marginBottom: 0, gap: 6 }}>
            <input
              type="checkbox"
              style={{ width: 'auto' }}
              checked={includeInactive}
              onChange={(event) => setIncludeInactive(event.target.checked)}
            />
            <span className="small">Show inactive</span>
          </label>
          <button
            className="btn btn--primary"
            onClick={() => {
              setNotice(null);
              setEditing({ ...BLANK, session: currentSession() });
            }}
          >
            New fee item
          </button>
        </div>
      </div>

      <div className="content">
        <ErrorNotice error={error} />
        {notice && <Notice kind="good">{notice}</Notice>}

        <section className="card">
          {!items ? (
            <Loading />
          ) : items.length === 0 ? (
            <Empty title="No fee items yet">
              Create one to make it payable by the students it applies to.
            </Empty>
          ) : (
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Category</th>
                    <th className="num">Amount</th>
                    <th>Applies to</th>
                    <th>Session</th>
                    <th>Status</th>
                    <th />
                  </tr>
                </thead>
                <tbody>
                  {items.map((item) => (
                    <tr key={item.fee_item_id}>
                      <td>{item.name}</td>
                      <td className="small">{item.category}</td>
                      <td className="num">{formatNaira(item.amount)}</td>
                      <td className="small">
                        {item.department || 'All departments'}
                        {' · '}
                        {item.level ? `Level ${item.level}` : 'All levels'}
                      </td>
                      <td className="small nowrap">{item.session}</td>
                      <td>
                        <span className={`badge badge--${item.is_active ? 'success' : 'neutral'}`}>
                          {item.is_active ? 'Active' : 'Inactive'}
                        </span>
                      </td>
                      <td>
                        <div className="row">
                          <button
                            className="btn btn--sm"
                            onClick={() => {
                              setNotice(null);
                              setEditing({
                                ...item,
                                department: item.department || '',
                                level: item.level || '',
                              });
                            }}
                          >
                            Edit
                          </button>
                          {item.is_active && (
                            <button className="btn btn--sm" onClick={() => deactivate(item)}>
                              Deactivate
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>

      {editing && (
        <FeeItemDialog
          item={editing}
          onClose={() => setEditing(null)}
          onSaved={(message) => {
            setEditing(null);
            setNotice(message);
            load();
          }}
        />
      )}
    </>
  );
}

function FeeItemDialog({ item, onClose, onSaved }) {
  const isNew = !item.fee_item_id;
  const [form, setForm] = useState(item);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const update = (key) => (event) =>
    setForm((previous) => ({ ...previous, [key]: event.target.value }));

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);

    const payload = {
      name: form.name.trim(),
      category: form.category,
      // Sent as a string: JSON numbers are doubles, and 1500.10 does not survive
      // that round trip exactly. The server parses it with a decimal library.
      amount: String(form.amount).trim(),
      department: form.department.trim() || null,
      level: form.level.trim() || null,
      session: form.session.trim(),
    };

    try {
      if (isNew) {
        await api.feeItems.create(payload);
        onSaved(`"${payload.name}" has been created.`);
      } else {
        await api.feeItems.update(item.fee_item_id, payload);
        onSaved(`"${payload.name}" has been updated.`);
      }
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={isNew ? 'New fee item' : `Edit ${item.name}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={busy}>
            {busy ? <span className="spinner" /> : isNew ? 'Create' : 'Save changes'}
          </button>
        </>
      }
    >
      <ErrorNotice error={error} />

      {!isNew && (
        <Notice kind="warn">
          Changing the amount affects new payments only. References already issued keep the
          amount the student was quoted.
        </Notice>
      )}

      <form onSubmit={submit}>
        <div className="field">
          <label htmlFor="name">Name</label>
          <input
            id="name"
            required
            maxLength={150}
            value={form.name}
            onChange={update('name')}
            placeholder="School Fees (Undergraduate)"
          />
        </div>

        <div className="filters">
          <div className="field">
            <label htmlFor="category">Category</label>
            <select id="category" value={form.category} onChange={update('category')}>
              {CATEGORIES.map((category) => (
                <option key={category} value={category}>
                  {category}
                </option>
              ))}
            </select>
          </div>

          <div className="field">
            <label htmlFor="amount">Amount (naira)</label>
            <input
              id="amount"
              required
              inputMode="decimal"
              pattern="^\d{1,10}(\.\d{1,2})?$"
              value={form.amount}
              onChange={update('amount')}
              placeholder="68500.00"
            />
          </div>

          <div className="field">
            <label htmlFor="session">Session</label>
            <input
              id="session"
              required
              pattern="^\d{4}/\d{4}$"
              value={form.session}
              onChange={update('session')}
              placeholder="2025/2026"
            />
          </div>
        </div>

        <div className="filters">
          <div className="field">
            <label htmlFor="department">Department</label>
            <input
              id="department"
              value={form.department}
              onChange={update('department')}
              placeholder="Leave blank for all departments"
              maxLength={100}
            />
          </div>

          <div className="field">
            <label htmlFor="level">Level</label>
            <input
              id="level"
              value={form.level}
              onChange={update('level')}
              placeholder="Leave blank for all levels"
              maxLength={10}
            />
          </div>
        </div>

        <p className="small muted">
          A blank department or level means the fee applies to everyone. Students only ever see
          fee items that apply to them.
        </p>
      </form>
    </Modal>
  );
}

/** The academic session that a new fee item most likely belongs to. */
function currentSession() {
  const now = new Date();
  // Nigerian academic sessions start around September.
  const startYear = now.getMonth() >= 8 ? now.getFullYear() : now.getFullYear() - 1;
  return `${startYear}/${startYear + 1}`;
}
