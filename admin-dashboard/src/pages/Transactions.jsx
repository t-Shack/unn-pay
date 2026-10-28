import { useCallback, useEffect, useState } from 'react';
import { api } from '../api/client';
import {
  ErrorNotice,
  Empty,
  Loading,
  Pagination,
  StatusBadge,
  formatNaira,
  formatWat,
} from '../components/ui';

/**
 * Transaction register (§11.6): filter by date range, department, level, status
 * and fee item, and export the filtered set as CSV or PDF.
 *
 * The export deliberately carries the same filters as the view, so what a
 * Bursary officer prints is exactly what they were looking at.
 */

const EMPTY_FILTERS = {
  from: '',
  to: '',
  department: '',
  level: '',
  status: '',
  matric_number: '',
};

export default function Transactions() {
  const [filters, setFilters] = useState(EMPTY_FILTERS);
  const [applied, setApplied] = useState(EMPTY_FILTERS);
  const [page, setPage] = useState(1);
  const [data, setData] = useState(null);
  const [error, setError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [exporting, setExporting] = useState(null);

  const load = useCallback(() => {
    setLoading(true);
    api.transactions
      .list({ ...applied, page, page_size: 25 })
      .then((result) => {
        setData(result);
        setError(null);
      })
      .catch(setError)
      .finally(() => setLoading(false));
  }, [applied, page]);

  useEffect(load, [load]);

  const submit = (event) => {
    event.preventDefault();
    setPage(1);
    setApplied(filters);
  };

  const reset = () => {
    setFilters(EMPTY_FILTERS);
    setApplied(EMPTY_FILTERS);
    setPage(1);
  };

  const exportAs = async (format) => {
    setExporting(format);
    setError(null);
    try {
      await api.transactions.export({ ...applied, format });
    } catch (caught) {
      setError(caught);
    } finally {
      setExporting(null);
    }
  };

  const update = (key) => (event) =>
    setFilters((previous) => ({ ...previous, [key]: event.target.value }));

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Transactions</h1>
          <div className="topbar__sub">
            {data ? `${data.pagination.total} record${data.pagination.total === 1 ? '' : 's'}` : '—'}
          </div>
        </div>
        <div className="row">
          <button className="btn" disabled={!!exporting} onClick={() => exportAs('csv')}>
            {exporting === 'csv' ? 'Preparing…' : 'Export CSV'}
          </button>
          <button className="btn" disabled={!!exporting} onClick={() => exportAs('pdf')}>
            {exporting === 'pdf' ? 'Preparing…' : 'Export PDF'}
          </button>
        </div>
      </div>

      <div className="content">
        <ErrorNotice error={error} />

        <section className="card" style={{ marginBottom: 16 }}>
          <div className="card__body">
            <form onSubmit={submit}>
              <div className="filters">
                <div className="field field--inline">
                  <label htmlFor="from">From</label>
                  <input id="from" type="date" value={filters.from} onChange={update('from')} />
                </div>
                <div className="field field--inline">
                  <label htmlFor="to">To</label>
                  <input id="to" type="date" value={filters.to} onChange={update('to')} />
                </div>
                <div className="field field--inline">
                  <label htmlFor="department">Department</label>
                  <input
                    id="department"
                    value={filters.department}
                    onChange={update('department')}
                    placeholder="Any"
                  />
                </div>
                <div className="field field--inline">
                  <label htmlFor="level">Level</label>
                  <input
                    id="level"
                    value={filters.level}
                    onChange={update('level')}
                    placeholder="Any"
                  />
                </div>
                <div className="field field--inline">
                  <label htmlFor="status">Status</label>
                  <select id="status" value={filters.status} onChange={update('status')}>
                    <option value="">Any</option>
                    <option value="Successful">Successful</option>
                    <option value="Pending">Pending</option>
                    <option value="UnderReview">Under review</option>
                    <option value="Failed">Failed</option>
                    <option value="Expired">Expired</option>
                  </select>
                </div>
                <div className="field field--inline">
                  <label htmlFor="matric">Matric number</label>
                  <input
                    id="matric"
                    value={filters.matric_number}
                    onChange={update('matric_number')}
                    placeholder="2022/248400"
                    maxLength={20}
                  />
                </div>
              </div>

              <div className="row row--end" style={{ marginTop: 12 }}>
                <button type="button" className="btn" onClick={reset}>
                  Clear
                </button>
                <button className="btn btn--primary">Apply filters</button>
              </div>
            </form>
          </div>
        </section>

        <section className="card">
          {loading && !data ? (
            <Loading />
          ) : data && data.items.length === 0 ? (
            <Empty title="No transactions match these filters">
              Try widening the date range, or clear the filters.
            </Empty>
          ) : (
            <>
              <div className="table-wrap">
                <table>
                  <thead>
                    <tr>
                      <th>Reference</th>
                      <th>Student</th>
                      <th>Fee item</th>
                      <th className="num">Expected</th>
                      <th className="num">Paid</th>
                      <th>Status</th>
                      <th>Channel</th>
                      <th>Receipt</th>
                      <th>Paid at</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((item) => (
                      <tr key={item.transaction_id}>
                        <td className="mono nowrap">{item.unn_reference}</td>
                        <td>
                          {item.student ? (
                            <>
                              <div>{item.student.full_name}</div>
                              <div className="small muted mono">{item.student.matric_number}</div>
                              <div className="small muted">
                                {item.student.department} · {item.student.level}
                              </div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td>
                          {item.fee_item ? (
                            <>
                              <div>{item.fee_item.name}</div>
                              <div className="small muted">{item.fee_item.session}</div>
                            </>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </td>
                        <td className="num">{formatNaira(item.expected_amount)}</td>
                        <td className="num">
                          {formatNaira(item.amount_paid)}
                          {item.variance && Number(item.variance) !== 0 && (
                            <div
                              className={`small ${
                                Number(item.variance) < 0 ? 'variance-negative' : 'variance-positive'
                              }`}
                            >
                              {Number(item.variance) > 0 ? '+' : ''}
                              {formatNaira(item.variance)}
                            </div>
                          )}
                        </td>
                        <td>
                          <StatusBadge status={item.status} />
                        </td>
                        <td className="small">{item.channel || '—'}</td>
                        <td className="mono small">{item.receipt_number || '—'}</td>
                        <td className="nowrap small">{formatWat(item.paid_at)}</td>
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
    </>
  );
}
