import { useEffect } from 'react';

/** Shared presentational pieces. Deliberately small and unclever. */

export function StatusBadge({ status }) {
  const map = {
    Successful: 'success',
    Pending: 'pending',
    UnderReview: 'review',
    Failed: 'failed',
    Expired: 'neutral',
    open: 'review',
    resolved: 'success',
    expired: 'neutral',
  };
  const labels = { UnderReview: 'Under review' };
  return (
    <span className={`badge badge--${map[status] || 'neutral'}`}>
      {labels[status] || status}
    </span>
  );
}

export function Notice({ kind = 'info', children }) {
  if (!children) return null;
  return <div className={`notice notice--${kind}`}>{children}</div>;
}

export function ErrorNotice({ error }) {
  if (!error) return null;
  return (
    <div className="notice notice--error">
      <strong>{error.message}</strong>
      {error.details && Array.isArray(error.details) && (
        <ul style={{ margin: '6px 0 0', paddingLeft: 18 }}>
          {error.details.map((detail, index) => (
            <li key={index}>
              {detail.field}: {detail.message}
            </li>
          ))}
        </ul>
      )}
      {error.correlationId && (
        <div className="small muted" style={{ marginTop: 6 }}>
          Reference for support: <span className="mono">{error.correlationId}</span>
        </div>
      )}
    </div>
  );
}

export function Empty({ title, children }) {
  return (
    <div className="empty">
      <strong>{title}</strong>
      {children}
    </div>
  );
}

export function Loading({ label = 'Loading…' }) {
  return <div className="loading">{label}</div>;
}

export function Modal({ title, onClose, children, footer }) {
  // Escape closes; the browser back button is not a close affordance here.
  useEffect(() => {
    const handler = (event) => {
      if (event.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal__head">
          <h2>{title}</h2>
        </div>
        <div className="modal__body">{children}</div>
        {footer && <div className="modal__foot">{footer}</div>}
      </div>
    </div>
  );
}

export function Pagination({ pagination, onPage }) {
  if (!pagination || pagination.total_pages <= 1) return null;
  const { page, total_pages: totalPages, total } = pagination;

  return (
    <div className="pagination">
      <span className="small muted">
        Page {page} of {totalPages} · {total} record{total === 1 ? '' : 's'}
      </span>
      <div className="row">
        <button className="btn btn--sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
          Previous
        </button>
        <button
          className="btn btn--sm"
          disabled={page >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </div>
  );
}

/** Times are stored in UTC and shown in West Africa Time (spec §3.1). */
export function formatWat(value, { withTime = true } = {}) {
  if (!value) return '—';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat('en-NG', {
    timeZone: 'Africa/Lagos',
    dateStyle: 'medium',
    ...(withTime ? { timeStyle: 'short' } : {}),
  }).format(date);
}

export function formatNaira(amount) {
  if (amount === null || amount === undefined || amount === '') return '—';
  const number = Number(amount);
  if (Number.isNaN(number)) return String(amount);
  // The sign goes before the symbol, as the API formats it: -₦3,000.00.
  return `${number < 0 ? '-' : ''}₦${Math.abs(number).toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}
