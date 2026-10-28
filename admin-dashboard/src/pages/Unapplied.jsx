import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  Empty,
  ErrorNotice,
  Loading,
  Modal,
  Notice,
  Pagination,
  StatusBadge,
  formatNaira,
  formatWat,
} from '../components/ui';

/**
 * The unapplied payments queue (§10).
 *
 * This is money that reached the University's account but could not be matched
 * to a fee. Nothing here is ever absorbed silently and nothing is ever deleted:
 * an item past its 90 day deadline stops appearing in the student's app but
 * stays here permanently, and Bursary can still resolve it at any later date.
 *
 * Every resolution requires a note, because every resolution is a decision
 * someone may have to justify later.
 */

const REASON_LABEL = {
  underpayment: 'Underpayment',
  overpayment: 'Overpayment',
  unknown_reference: 'Unknown reference',
  expired_reference: 'Expired reference',
  duplicate_payment: 'Duplicate payment',
};

const REASON_EXPLANATION = {
  underpayment: 'The student sent less than the fee costs.',
  overpayment: 'The student sent more than the fee costs.',
  unknown_reference: 'The money quoted a reference UNN never issued.',
  expired_reference: 'The money arrived after the reference had expired.',
  duplicate_payment: 'This fee had already been paid.',
};

const RESOLUTIONS = [
  {
    value: 'applied_to_intended_fee',
    label: 'Apply to the intended fee',
    help: 'Settles the original fee and issues the receipt that was withheld.',
  },
  {
    value: 'applied_to_other_fee',
    label: 'Apply to a different fee',
    help: 'Records the payment against another fee item and issues a receipt for it.',
  },
  {
    value: 'marked_for_refund',
    label: 'Mark for refund',
    help: 'No fee is settled. Records that the money is to be returned to the student.',
  },
  {
    value: 'dismissed',
    label: 'Dismiss',
    help: 'Closes the item without settling anything. Use when it was handled elsewhere.',
  },
];

export default function Unapplied() {
  const [status, setStatus] = useState('open');
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [resolving, setResolving] = useState(null);
  const [confirmation, setConfirmation] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.unapplied
      .list({ status, page, page_size: 25 })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [status, page]);

  useEffect(load, [load]);

  const onResolved = (item, response) => {
    setResolving(null);
    setConfirmation(
      response.receipt_number
        ? `Applied. Receipt ${response.receipt_number} has been issued to ${
            item.student ? item.student.full_name : 'the student'
          }.`
        : 'Recorded. The item is now resolved and the student has been notified.'
    );
    load();
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Unapplied payments</h1>
          <div className="topbar__sub">
            Money received that could not be matched to a fee automatically
          </div>
        </div>
        <div className="row">
          {['open', 'resolved', 'expired', 'all'].map((value) => (
            <button
              key={value}
              className={`btn btn--sm${status === value ? ' btn--primary' : ''}`}
              onClick={() => {
                setStatus(value);
                setPage(1);
              }}
            >
              {value[0].toUpperCase() + value.slice(1)}
            </button>
          ))}
        </div>
      </div>

      <div className="content">
        <ErrorNotice error={error} />
        {confirmation && <Notice kind="good">{confirmation}</Notice>}

        {status === 'expired' && (
          <Notice kind="warn">
            These items passed their 90 day resolution deadline and no longer appear in the
            student's app. They are kept permanently and can still be resolved here.
          </Notice>
        )}

        <section className="card">
          {loading && !data ? (
            <Loading />
          ) : data && data.items.length === 0 ? (
            <Empty title={status === 'open' ? 'Nothing waiting' : 'No items'}>
              {status === 'open'
                ? 'Every payment received has been matched to a fee.'
                : 'There are no items with this status.'}
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Student</th>
                      <th>Reason</th>
                      <th className="num">Received</th>
                      <th className="num">Expected</th>
                      <th className="num">Difference</th>
                      <th>Reference</th>
                      <th>Deadline</th>
                      <th>Status</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.unapplied_id}>
                        <td>
                          {item.student ? (
                            <>
                              <div>{item.student.full_name}</div>
                              <div className="small muted mono">{item.student.matric_number}</div>
                            </>
                          ) : (
                            <span className="muted">Unidentified payer</span>
                          )}
                        </td>
                        <td>
                          <div>{REASON_LABEL[item.reason] || item.reason}</div>
                          <div className="small muted">{REASON_EXPLANATION[item.reason]}</div>
                        </td>
                        <td className="num">{formatNaira(item.amount_received)}</td>
                        <td className="num">{formatNaira(item.amount_expected)}</td>
                        <td className="num">
                          {item.variance ? (
                            <span
                              className={
                                Number(item.variance) < 0 ? 'variance-negative' : 'variance-positive'
                              }
                            >
                              {Number(item.variance) > 0 ? '+' : ''}
                              {formatNaira(item.variance)}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td className="mono small">{item.unn_reference || '—'}</td>
                        <td className="nowrap small">
                          {formatWat(item.deadline_at, { withTime: false })}
                          {item.status === 'open' && item.days_remaining !== null && (
                            <div
                              className={`small ${
                                item.days_remaining < 14 ? 'variance-negative' : 'muted'
                              }`}
                            >
                              {item.days_remaining > 0
                                ? `${item.days_remaining} days left`
                                : 'Past deadline'}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={item.status} />
                          {item.resolution && (
                            <div className="small muted" style={{ marginTop: 3 }}>
                              {(RESOLUTIONS.find((r) => r.value === item.resolution) || {}).label}
                            </div>
                          )}
                        </td>
                        <td>
                          {item.status === 'resolved' ? (
                            <span className="small muted">
                              {item.resolved_by ? item.resolved_by.full_name : '—'}
                            </span>
                          ) : (
                            <button
                              className="btn btn--sm btn--primary"
                              onClick={() => {
                                setConfirmation(null);
                                setResolving(item);
                              }}
                            >
                              Resolve
                            </button>
                          )}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <Pagination pagination={data.pagination} onPage={setPage} />
            </>
          )}
        </section>
      </div>

      {resolving && (
        <ResolveDialog
          item={resolving}
          onClose={() => setResolving(null)}
          onResolved={onResolved}
        />
      )}
    </>
  );
}

function ResolveDialog({ item, onClose, onResolved }) {
  const [resolution, setResolution] = useState('applied_to_intended_fee');
  const [note, setNote] = useState('');
  const [targetFeeItemId, setTargetFeeItemId] = useState('');
  const [feeItems, setFeeItems] = useState([]);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    api.feeItems
      .list({})
      .then((result) => setFeeItems(result.items || []))
      .catch(() => setFeeItems([]));
  }, []);

  // Applying to the intended fee is only possible when there is one.
  const canApplyToIntended = Boolean(item.transaction);
  useEffect(() => {
    if (!canApplyToIntended && resolution === 'applied_to_intended_fee') {
      setResolution(item.student ? 'applied_to_other_fee' : 'marked_for_refund');
    }
  }, [canApplyToIntended, resolution, item.student]);

  const needsTarget = resolution === 'applied_to_other_fee';
  const valid =
    note.trim().length >= 5 && (!needsTarget || targetFeeItemId) && !busy;

  const submit = async (event) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await api.unapplied.resolve(item.unapplied_id, {
        resolution,
        note: note.trim(),
        ...(needsTarget ? { target_fee_item_id: Number(targetFeeItemId) } : {}),
      });
      onResolved(item, response);
    } catch (caught) {
      setError(caught);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={`Resolve payment #${item.unapplied_id}`}
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose} disabled={busy}>
            Cancel
          </button>
          <button className="btn btn--primary" onClick={submit} disabled={!valid}>
            {busy ? <span className="spinner" /> : 'Resolve'}
          </button>
        </>
      }
    >
      <ErrorNotice error={error} />

      <div className="notice">
        <dl className="definition">
          <dt>Student</dt>
          <dd>
            {item.student
              ? `${item.student.full_name} (${item.student.matric_number})`
              : 'Unidentified payer'}
          </dd>
          <dt>Reason</dt>
          <dd>{REASON_LABEL[item.reason] || item.reason}</dd>
          <dt>Amount received</dt>
          <dd>{formatNaira(item.amount_received)}</dd>
          <dt>Amount expected</dt>
          <dd>{formatNaira(item.amount_expected)}</dd>
          {item.payer_details && item.payer_details.payer_account_name && (
            <>
              <dt>Paid by</dt>
              <dd>
                {item.payer_details.payer_account_name}
                {item.payer_details.payer_bank ? ` · ${item.payer_details.payer_bank}` : ''}
              </dd>
            </>
          )}
          <dt>Deadline</dt>
          <dd>{formatWat(item.deadline_at, { withTime: false })}</dd>
        </dl>
      </div>

      <form onSubmit={submit}>
        <div className="field">
          <label>What should happen to this money?</label>
          {RESOLUTIONS.map((option) => {
            const disabled =
              (option.value === 'applied_to_intended_fee' && !canApplyToIntended) ||
              (option.value === 'applied_to_other_fee' && !item.student);

            return (
              <label
                key={option.value}
                className={`option${resolution === option.value ? ' option--selected' : ''}${
                  disabled ? ' option--disabled' : ''
                }`}
              >
                <input
                  type="radio"
                  name="resolution"
                  checked={resolution === option.value}
                  disabled={disabled}
                  onChange={() => setResolution(option.value)}
                />
                <span>
                  <span style={{ fontWeight: 800 }}>{option.label}</span>
                  <span className="small muted" style={{ display: 'block', fontWeight: 400 }}>
                    {disabled
                      ? option.value === 'applied_to_intended_fee'
                        ? 'Not available: this payment is not linked to a fee attempt.'
                        : 'Not available: this payment is not linked to a student.'
                      : option.help}
                  </span>
                </span>
              </label>
            );
          })}
        </div>

        {needsTarget && (
          <div className="field">
            <label htmlFor="target">Fee item to apply it to</label>
            <select
              id="target"
              value={targetFeeItemId}
              onChange={(event) => setTargetFeeItemId(event.target.value)}
              required
            >
              <option value="">Choose a fee item…</option>
              {feeItems.map((fee) => (
                <option key={fee.fee_item_id} value={fee.fee_item_id}>
                  {fee.name} — {formatNaira(fee.amount)} ({fee.session})
                </option>
              ))}
            </select>
          </div>
        )}

        <div className="field">
          <label htmlFor="note">
            Resolution note <span style={{ color: 'var(--red)' }}>required</span>
          </label>
          <textarea
            id="note"
            value={note}
            onChange={(event) => setNote(event.target.value)}
            placeholder="What was decided, and why. For example: student paid the ₦8,500 balance in cash at the counter, receipt 4471."
            required
            minLength={5}
          />
          <div className="small muted" style={{ marginTop: 4 }}>
            This note is written to the permanent audit log alongside your name.
          </div>
        </div>
      </form>
    </Modal>
  );
}
