import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { AdminShell, DashboardPage } from './admin/AdminShell';
import { AuthProvider } from './admin/AuthContext';
import { FlightEstimatesPage } from './admin/FlightEstimatesPage';
import { FxPage } from './admin/FxPage';
import { HotelsPage } from './admin/HotelsPage';
import { LoginPage } from './admin/LoginPage';
import { SettingsPage } from './admin/SettingsPage';
import { SuppliersPage } from './admin/SuppliersPage';
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
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="hotels" element={<HotelsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="fx" element={<FxPage />} />
          <Route path="flight-estimates" element={<FlightEstimatesPage />} />
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
