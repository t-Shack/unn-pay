import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api/client';
import { ErrorNotice, Loading, formatWat } from '../components/ui';
import { useAuth } from '../context/AuthContext';

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
  const sandbox = health.bank_adapter?.name === 'sandbox';

  const statusEntries = Object.entries(summary.by_status || {});
  const statusTotal = statusEntries.reduce((sum, [, count]) => sum + Number(count || 0), 0);

  return (
    <>
      <Topbar sandbox={sandbox} />

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

        <section className="grid grid--4" style={{ marginBottom: 16 }}>
          <div className="card stat stat--forest">
            <span className="ring" aria-hidden="true" />
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

          <div className={`card stat ${health.open_unapplied_payments > 0 ? 'stat--gold' : ''}`}>
            <div className="stat__label">Unapplied payments</div>
            <div className="stat__value">
              {health.open_unapplied_payments > 0
                ? `${health.open_unapplied_payments} open`
                : health.open_unapplied_payments}
            </div>
            <div className="stat__hint">
              {health.open_unapplied_payments > 0 ? (
                <Link to="/unapplied">Open the queue →</Link>
              ) : (
                'Nothing waiting'
              )}
            </div>
          </div>

          <div className={`card stat ${health.pending_older_than_30_minutes > 0 ? 'stat--warn' : ''}`}>
            <div className="stat__label">Pending over 30 minutes</div>
            <div className="stat__value">{health.pending_older_than_30_minutes}</div>
            <div className="stat__hint">Reconciliation checks these every 10 minutes</div>
          </div>
        </section>

        <div className="grid grid--2">
          <section className="card">
            <div className="card__head">
              <h2>System health</h2>
              <span className={`badge badge--${circuitOk && health.outbox.dead === 0 ? 'success' : 'failed'}`}>
                {circuitOk && health.outbox.dead === 0 ? 'All normal' : 'Needs a look'}
              </span>
            </div>
            <div className="card__body" style={{ paddingTop: 4 }}>
              <div className="health-row">
                <span className="dot dot--good" />
                <span className="health-row__label">Bank adapter</span>
                <span className="health-row__value">
                  {health.bank_adapter.display_name}{' '}
                  <span className="badge badge--neutral">{health.bank_adapter.name}</span>
                </span>
              </div>
              <div className="health-row">
                <span className={`dot ${circuitOk ? 'dot--good' : 'dot--bad'}`} />
                <span className="health-row__label">Circuit breaker</span>
                <span className="health-row__value" style={{ textTransform: 'capitalize' }}>
                  {circuit.state || 'unknown'}
                  {!circuitOk && circuit.last_error && (
                    <div className="small muted" style={{ fontWeight: 400, textTransform: 'none' }}>
                      {circuit.last_error}
                    </div>
                  )}
                </span>
              </div>
              <div className="health-row">
                <span className={`dot ${health.outbox.pending > 20 ? 'dot--warn' : 'dot--good'}`} />
                <span className="health-row__label">Notification queue</span>
                <span className="health-row__value">
                  {health.outbox.pending} pending · {health.outbox.processing} in flight ·{' '}
                  {health.outbox.done} delivered
                </span>
              </div>
              <div className="health-row">
                <span className={`dot ${health.outbox.dead > 0 ? 'dot--bad' : 'dot--good'}`} />
                <span className="health-row__label">Failed permanently</span>
                <span className={`health-row__value ${health.outbox.dead > 0 ? 'variance-negative' : ''}`}>
                  {health.outbox.dead}
                </span>
              </div>
              <div className="health-row">
                <span className="dot" />
                <span className="health-row__label">Reference validity</span>
                <span className="health-row__value">
                  {health.configuration.payment_reference_ttl_hours} hours
                </span>
              </div>
              <div className="health-row">
                <span className="dot" />
                <span className="health-row__label">Resolution window</span>
                <span className="health-row__value">
                  {health.configuration.unapplied_resolution_days} days
                </span>
              </div>
              <div className="small muted" style={{ marginTop: 10 }}>
                Refreshed {formatWat(health.generated_at)}
              </div>
            </div>
          </section>

          <section className="card">
            <div className="card__head">
              <h2>Payments by status</h2>
              <span className="small muted">{statusTotal} in total</span>
            </div>
            <div className="card__body" style={{ paddingTop: 8 }}>
              {statusTotal === 0 ? (
                <p className="muted">No payments yet.</p>
              ) : (
                <>
                  <div
                    className="status-bar"
                    role="img"
                    aria-label={statusEntries
                      .map(([status, count]) => `${count} ${STATUS_LABELS[status] || status}`)
                      .join(', ')}
                  >
                    {statusEntries.map(([status, count]) => (
                      <span
                        key={status}
                        style={{
                          width: `${(Number(count) / statusTotal) * 100}%`,
                          background: STATUS_COLORS[status] || '#c9d1cc',
                        }}
                      />
                    ))}
                  </div>
                  <div className="legend">
                    {statusEntries.map(([status, count]) => (
                      <div className="legend__row" key={status}>
                        <span
                          className="legend__swatch"
                          style={{ background: STATUS_COLORS[status] || '#c9d1cc' }}
                        />
                        <span className="legend__label">{STATUS_LABELS[status] || status}</span>
                        <span className="legend__value">{count}</span>
                      </div>
                    ))}
                  </div>
                </>
              )}
            </div>
          </section>
        </div>

        {deadEntries.length > 0 && (
          <section className="card" style={{ marginTop: 16 }}>
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

const STATUS_COLORS = {
  Successful: '#0e6b4a',
  Pending: '#f2b630',
  UnderReview: '#c2410c',
  Expired: '#c9d1cc',
  Failed: '#b42318',
};

const STATUS_LABELS = { UnderReview: 'Under review' };

function greeting() {
  const hour = Number(
    new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: 'numeric', hour12: false })
      .format(new Date())
  );
  if (hour < 12) return 'Good morning';
  if (hour < 17) return 'Good afternoon';
  return 'Good evening';
}

function Topbar({ sandbox = false }) {
  const { admin } = useAuth();
  const first = (admin?.full_name || '').trim().split(/\s+/)[0];
  return (
    <div className="topbar">
      <div>
        <h1>
          {greeting()}
          {first ? `, ${first}` : ''}
        </h1>
        <div className="topbar__sub">Collections and system health</div>
      </div>
      {sandbox && (
        <span className="badge badge--pending" style={{ padding: '8px 12px' }}>
          Sandbox bank · no real money
        </span>
      )}
    </div>
  );
}
