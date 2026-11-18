/** The staff area, loaded on demand from App. Staff auth state lives only here. */
import { Outlet, Route, Routes } from 'react-router-dom';
import { AdminShell, DashboardPage } from './AdminShell';
import { AuthProvider } from './AuthContext';
import { FlightEstimatesPage } from './FlightEstimatesPage';
import { FxPage } from './FxPage';
import { HotelsPage } from './HotelsPage';
import { LoginPage } from './LoginPage';
import { RatePackagePage } from './RatePackagePage';
import { RateSheetsPage } from './RateSheetsPage';
import { SettingsPage } from './SettingsPage';
import { SuppliersPage } from './SuppliersPage';
import { UsersPage } from './UsersPage';

function AdminArea() {
  return (
    <AuthProvider>
      <Outlet />
    </AuthProvider>
  );
}

export default function AdminRoutes() {
  return (
    <Routes>
      <Route element={<AdminArea />}>
        <Route path="login" element={<LoginPage />} />
        <Route element={<AdminShell />}>
          <Route index element={<DashboardPage />} />
          <Route path="users" element={<UsersPage />} />
          <Route path="rate-sheets" element={<RateSheetsPage />} />
          <Route path="rate-sheets/:packageId" element={<RatePackagePage />} />
          <Route path="suppliers" element={<SuppliersPage />} />
          <Route path="hotels" element={<HotelsPage />} />
          <Route path="settings" element={<SettingsPage />} />
          <Route path="fx" element={<FxPage />} />
          <Route path="flight-estimates" element={<FlightEstimatesPage />} />
        </Route>
      </Route>
    </Routes>
  );
}
