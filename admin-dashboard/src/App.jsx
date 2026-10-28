import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuth } from './context/AuthContext';
import { api } from './api/client';
import { Loading } from './components/ui';
import {
  AlertIcon,
  OverviewIcon,
  PeopleIcon,
  SignOutIcon,
  TagIcon,
  TransactionsIcon,
  UploadIcon,
} from './components/icons';

import Login from './pages/Login';
import Overview from './pages/Overview';
import Transactions from './pages/Transactions';
import Unapplied from './pages/Unapplied';
import FeeItems from './pages/FeeItems';
import StudentImport from './pages/StudentImport';
import Staff from './pages/Staff';

/**
 * The dashboard shell and routing.
 *
 * The unapplied payment count sits in the navigation permanently: it is money
 * that has arrived and not reached a student's record, and it is the one number
 * on this dashboard that must never be quietly ignored.
 */

const PAGES = [
  { to: '/', label: 'Overview', end: true, icon: OverviewIcon },
  { to: '/transactions', label: 'Transactions', icon: TransactionsIcon },
  { to: '/unapplied', label: 'Unapplied payments', badge: 'unapplied', icon: AlertIcon },
  { to: '/fee-items', label: 'Fee items', icon: TagIcon },
  { to: '/students', label: 'Student import', icon: UploadIcon },
  { to: '/staff', label: 'Staff', superAdminOnly: true, icon: PeopleIcon },
];

function initials(name = '') {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] || '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase();
}

function Shell({ children }) {
  const { admin, signOut, isSuperAdmin } = useAuth();
  const [openUnapplied, setOpenUnapplied] = useState(0);
  const location = useLocation();

  // Refresh the queue count on navigation and every 60 seconds, so a Bursary
  // officer with the dashboard open all day sees new items arrive.
  useEffect(() => {
    let cancelled = false;
    const load = () =>
      api.dashboard
        .health()
        .then((health) => {
          if (!cancelled) setOpenUnapplied(health.open_unapplied_payments || 0);
        })
        .catch(() => {});

    load();
    const timer = setInterval(load, 60000);
    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [location.pathname]);

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="sidebar__brand">
          <span className="brand-mark" aria-hidden="true">
            U
          </span>
          <div>
            <strong>UNN Pay</strong>
            <span>Bursary Department</span>
          </div>
        </div>

        <nav className="sidebar__nav" aria-label="Dashboard">
          {PAGES.filter((page) => !page.superAdminOnly || isSuperAdmin).map((page) => {
            const PageIcon = page.icon;
            return (
              <NavLink
                key={page.to}
                to={page.to}
                end={page.end}
                className={({ isActive }) => `navlink${isActive ? ' active' : ''}`}
              >
                <PageIcon />
                <span className="navlink__label">{page.label}</span>
                {page.badge === 'unapplied' && openUnapplied > 0 && (
                  <span className="navlink__count">{openUnapplied}</span>
                )}
              </NavLink>
            );
          })}
        </nav>

        <div className="sidebar__foot">
          <span className="sidebar__avatar" aria-hidden="true">
            {initials(admin.full_name)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="sidebar__who">{admin.full_name}</div>
            <div className="sidebar__role">{String(admin.role || '').replace(/_/g, ' ')}</div>
          </div>
          <button
            className="sidebar__signout"
            onClick={signOut}
            aria-label="Sign out"
            title="Sign out"
          >
            <SignOutIcon size={18} />
          </button>
        </div>
      </aside>

      <div className="main">{children}</div>
    </div>
  );
}

export default function App() {
  const { admin, ready, isSuperAdmin } = useAuth();

  if (!ready) return <Loading label="Checking your session…" />;
  if (!admin) return <Login />;

  return (
    <Shell>
      <Routes>
        <Route path="/" element={<Overview />} />
        <Route path="/transactions" element={<Transactions />} />
        <Route path="/unapplied" element={<Unapplied />} />
        <Route path="/fee-items" element={<FeeItems />} />
        <Route path="/students" element={<StudentImport />} />
        <Route
          path="/staff"
          element={isSuperAdmin ? <Staff /> : <Navigate to="/" replace />}
        />
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Shell>
  );
}
