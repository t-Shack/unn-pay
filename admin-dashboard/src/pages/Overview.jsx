import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNotice, Loading, formatNaira, formatWat } from '../components/ui';

/**
 * Overview: the money collected, and the operational health panel the
 * specification requires (§9.6) — stuck payments, open unapplied items, dead
 * outbox entries, and the bank circuit breaker's state.
 *
 * The health panel is the part that matters. A system whose selling point is
 * resilience has to show its own condition, not just claim it.
 */
export default function Overview() {
  const [summary, setSummary] = useState(null);
  const [health, setHealth] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    const load = () =>
      Promise.all([api.dashboard.summary(), api.dashboard.health()])
        .then(([summaryResult, healthResult]) => {
          if (cancelled) return;
          setSummary(summaryResult);
          setHealth(healthResult);
          setError(null);
        })
        .catch((caught) => {
          if (!cancelled) setError(caught);
        });

    load();
    const timer = setInterval(load, 30000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, []);

  if (error) {
    return (
      <>
        <Topbar />
        <div className="content">
          <ErrorNotice error={error} />
        </div>
      </>
    );
  }

  if (!summary || !health) {
    return (
      <>
        <Topbar />
        <Loading />
      </>
    );
  }

  const circuit = health.circuit_breaker || {};
  const circuitOk = circuit.state === 'closed';
  const deadEntries = health.dead_outbox_entries || [];

  return (
    <>
      <Topbar />

      <div className="content">
        {!circuitOk && (
          <div className="notice notice--error">
            <strong>The bank connection is degraded.</strong> The circuit breaker is{' '}
            {circuit.state === 'open' ? 'open' : 'half open'} after{' '}
            {circuit.consecutive_failures} consecutive failures
            {circuit.retry_at ? `, and will retry at ${formatWat(circuit.retry_at)}` : ''}. New
            payment references are still being issued, and virtual accounts are queued for
            creation as soon as the bank recovers.
          </div>
        )}

        {health.unapplied_past_deadline > 0 && (
          <div className="notice notice--warn">
            <strong>{health.unapplied_past_deadline}</strong> unapplied payment
            {health.unapplied_past_deadline === 1 ? ' has' : 's have'} passed the 90 day
            resolution deadline. They remain on record permanently and can still be resolved.{' '}
            <Link to="/unapplied">Review them</Link>.
          </div>
        )}

        <section className="grid grid--4" style={{ marginBottom: 18 }}>
          <div className="card stat stat--good">
            <div className="stat__label">Total collected</div>
            <div className="stat__value">{summary.total_collected_formatted}</div>
            <div className="stat__hint">
              {summary.successful_payments} settled payment
              {summary.successful_payments === 1 ? '' : 's'}
            </div>
          </div>

          <div className="card stat">
            <div className="stat__label">Students</div>
            <div className="stat__value">{summary.students.total}</div>
            <div className="stat__hint">
              {summary.students.active} activated · {summary.students.imported} not yet activated
            </div>
          </div>

          <div
            className={`card stat ${health.open_unapplied_payments > 0 ? 'stat--warn' : ''}`}
          >
            <div className="stat__label">Unapplied payments</div>
            <div className="stat__value">{health.open_unapplied_payments}</div>
            <div className="stat__hint">
              {health.open_unapplied_payments > 0 ? (
                <Link to="/unapplied">Open the queue</Link>
              ) : (
                'Nothing waiting'
              )}
            </div>
          </div>

          <div className={`card stat ${health.pending_older_than_30_minutes > 0 ? 'stat--warn' : ''}`}>
            <div className="stat__label">Pending over 30 minutes</div>
            <div className="stat__value">{health.pending_older_than_30_minutes}</div>
            <div className="stat__hint">
              Reconciliation checks these every 10 minutes
            </div>
          </div>
        </section>

        <div className="grid grid--2">
          <section className="card">
            <div className="card__head">
              <h2>System health</h2>
              <span className="small muted">Refreshed {formatWat(health.generated_at)}</span>
            </div>
            <div className="card__body">
              <dl className="definition">
                <dt>Bank adapter</dt>
                <dd>
                  {health.bank_adapter.display_name}{' '}
                  <span className="badge badge--neutral">{health.bank_adapter.name}</span>
                </dd>

                <dt>Circuit breaker</dt>
                <dd>
                  <span className={`badge badge--${circuitOk ? 'success' : 'failed'}`}>
                    {circuit.state || 'unknown'}
                  </span>
                  {!circuitOk && circuit.last_error && (
                    <div className="small muted" style={{ fontWeight: 400, marginTop: 4 }}>
                      {circuit.last_error}
                    </div>
                  )}
                </dd>

                <dt>Notification queue</dt>
                <dd>
                  {health.outbox.pending} pending · {health.outbox.processing} in flight ·{' '}
                  {health.outbox.done} delivered
                </dd>

                <dt>Failed permanently</dt>
                <dd className={health.outbox.dead > 0 ? 'variance-negative' : ''}>
                  {health.outbox.dead}
                </dd>

                <dt>Reference validity</dt>
                <dd>{health.configuration.payment_reference_ttl_hours} hours</dd>

                <dt>Resolution window</dt>
                <dd>{health.configuration.unapplied_resolution_days} days</dd>
              </dl>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <h2>Payments by status</h2>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Status</th>
                    <th className="num">Count</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.keys(summary.by_status).length === 0 ? (
                    <tr>
                      <td colSpan={2} className="muted">
                        No payments yet.
                      </td>
                    </tr>
                  ) : (
                    Object.entries(summary.by_status).map(([status, count]) => (
                      <tr key={status}>
                        <td>{status === 'UnderReview' ? 'Under review' : status}</td>
                        <td className="num">{count}</td>
                      </tr>
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </section>
        </div>

        {deadEntries.length > 0 && (
          <section className="card" style={{ marginTop: 18 }}>
            <div className="card__head">
              <h2>Notifications that failed permanently</h2>
              <span className="small muted">
                These gave up after 8 attempts and need a person to look at them
              </span>
            </div>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>Event</th>
                    <th className="num">Attempts</th>
                    <th>Last error</th>
                    <th>When</th>
                  </tr>
                </thead>
                <tbody>
                  {deadEntries.map((entry) => (
                    <tr key={entry.outbox_id}>
                      <td className="mono">{entry.event_type}</td>
                      <td className="num">{entry.attempt_count}</td>
                      <td className="small">{entry.last_error}</td>
                      <td className="nowrap small">{formatWat(entry.updated_at)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        )}
      </div>
    </>
  );
}

function Topbar() {
  return (
    <div className="topbar">
      <div>
        <h1>Overview</h1>
        <div className="topbar__sub">Collections and system health</div>
      </div>
    </div>
  );
}
