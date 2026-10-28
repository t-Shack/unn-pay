/**
 * API client for the Bursary dashboard.
 *
 * Two things here are load bearing:
 *
 *  1. Access tokens live for 15 minutes, so a 401 mid session is normal, not an
 *     error. The client refreshes once, transparently, and replays the request.
 *  2. Concurrent 401s must not each try to refresh — that would rotate the
 *     refresh token several times over and trip the reuse detection on the
 *     server, logging the user out for being legitimate. So refreshes are
 *     funnelled through a single shared promise.
 */

const BASE_URL = (import.meta.env.VITE_API_BASE_URL || '').replace(/\/+$/, '');
const API = `${BASE_URL}/api/v1`;

const STORAGE_KEY = 'unn-pay-admin-session';

export class ApiError extends Error {
  constructor(message, { status, code, details, correlationId } = {}) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.correlationId = correlationId;
  }
}

export const session = {
  read() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch {
      return null;
    }
  },
  write(value) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(value));
    } catch {
      /* a private window with storage disabled still works, just not across reloads */
    }
  },
  clear() {
    try {
      localStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
  },
};

let refreshInFlight = null;
let onUnauthenticated = () => {};

export const setUnauthenticatedHandler = (fn) => {
  onUnauthenticated = fn;
};

async function parse(response) {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function refreshTokens() {
  // One refresh at a time, shared by every caller that hit a 401 together.
  if (refreshInFlight) return refreshInFlight;

  const current = session.read();
  if (!current || !current.tokens || !current.tokens.refresh_token) {
    return Promise.resolve(null);
  }

  refreshInFlight = (async () => {
    try {
      const response = await fetch(`${API}/admin/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refresh_token: current.tokens.refresh_token }),
      });

      if (!response.ok) {
        session.clear();
        onUnauthenticated();
        return null;
      }

      const body = await parse(response);
      const next = { ...current, tokens: body.tokens };
      session.write(next);
      return next.tokens;
    } finally {
      refreshInFlight = null;
    }
  })();

  return refreshInFlight;
}

async function request(path, { method = 'GET', body, headers = {}, raw = false, retry = true } = {}) {
  const current = session.read();

  const isFormData = body instanceof FormData;
  const requestHeaders = {
    Accept: raw ? '*/*' : 'application/json',
    ...(isFormData || !body ? {} : { 'Content-Type': 'application/json' }),
    ...(current && current.tokens
      ? { Authorization: `Bearer ${current.tokens.access_token}` }
      : {}),
    ...headers,
  };

  const response = await fetch(`${API}${path}`, {
    method,
    headers: requestHeaders,
    body: isFormData ? body : body ? JSON.stringify(body) : undefined,
  });

  if (response.status === 401 && retry && current) {
    const refreshed = await refreshTokens();
    if (refreshed) {
      return request(path, { method, body, headers, raw, retry: false });
    }
  }

  if (!response.ok) {
    const parsed = await parse(response);
    const error = (parsed && parsed.error) || {};
    throw new ApiError(error.message || `Request failed (${response.status})`, {
      status: response.status,
      code: error.code,
      details: error.details,
      correlationId: error.correlation_id || response.headers.get('x-correlation-id'),
    });
  }

  if (raw) return response;
  return parse(response);
}

const query = (params = {}) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && value !== '') search.set(key, value);
  }
  const text = search.toString();
  return text ? `?${text}` : '';
};

/** Download a file the API returns as a blob, preserving its filename. */
async function download(path, fallbackName) {
  const response = await request(path, { raw: true });
  const blob = await response.blob();

  const disposition = response.headers.get('content-disposition') || '';
  const match = /filename="([^"]+)"/.exec(disposition);
  const filename = match ? match[1] : fallbackName;

  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

export const api = {
  login: (email, password) =>
    request('/admin/login', { method: 'POST', body: { email, password } }),

  me: () => request('/admin/me'),

  dashboard: {
    health: () => request('/admin/dashboard/health'),
    summary: (session_) => request(`/admin/dashboard/summary${query({ session: session_ })}`),
  },

  transactions: {
    list: (filters) => request(`/admin/transactions${query(filters)}`),
    export: (filters) =>
      download(
        `/admin/transactions/export${query(filters)}`,
        `unn-pay-transactions.${filters.format || 'csv'}`
      ),
  },

  unapplied: {
    list: (filters) => request(`/admin/unapplied${query(filters)}`),
    resolve: (id, payload) =>
      request(`/admin/unapplied/${id}/resolve`, {
        method: 'POST',
        body: payload,
        // A resolution settles money. Replaying it must never do the work twice.
        headers: { 'Idempotency-Key': `resolve-${id}-${payload.resolution}-${Date.now()}` },
      }),
  },

  feeItems: {
    list: (filters) => request(`/admin/fee-items${query(filters)}`),
    create: (payload) => request('/admin/fee-items', { method: 'POST', body: payload }),
    update: (id, payload) => request(`/admin/fee-items/${id}`, { method: 'PUT', body: payload }),
    deactivate: (id) => request(`/admin/fee-items/${id}`, { method: 'DELETE' }),
  },

  students: {
    preview: (file, session_) => {
      const form = new FormData();
      form.append('file', file);
      form.append('session', session_);
      return request('/admin/students/import', { method: 'POST', body: form });
    },
    commit: (importId, allowPartial) =>
      request(`/admin/students/imports/${importId}/commit`, {
        method: 'POST',
        body: { allow_partial: Boolean(allowPartial) },
      }),
    imports: () => request('/admin/students/imports'),
    getImport: (id) => request(`/admin/students/imports/${id}`),
  },

  staff: {
    create: (payload) => request('/admin/staff', { method: 'POST', body: payload }),
  },
};
