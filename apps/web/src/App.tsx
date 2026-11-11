import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AdminShell, DashboardPage } from './admin/AdminShell';
import { AuthProvider } from './admin/AuthContext';
import { LoginPage } from './admin/LoginPage';
import { UsersPage } from './admin/UsersPage';
import { HomePage } from './HomePage';

/** Staff auth state is only loaded under /admin; public pages never call it. */
function AdminArea() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export function App() {
  return (
    <Routes>
      <Route path="/" element={<HomePage />} />
      <Route path="/admin" element={<AdminArea />}>
        <Route path="login" element={<LoginPage />} />
        <Route element={<AdminShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="users" element={<UsersPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
