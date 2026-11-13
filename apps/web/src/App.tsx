import { Suspense, lazy } from 'react';
import { Navigate, Route, Routes } from 'react-router-dom';
import { AdminLoadBoundary } from './AdminLoadBoundary';
import { UmrahPage } from './public/calculator/UmrahPage';
import {
  ContactPage,
  FaqPage,
  FlightsPage,
  HomePage,
  HotelsPage,
  PolicyPage,
  TransportPage,
  VisaPage,
} from './public/pages';
import { PublicLayout } from './public/PublicLayout';

/**
 * Staff screens load on demand, so customers never download the admin code
 * (it keeps the public pages fast on 4G: docs/01 section 9).
 */
const AdminRoutes = lazy(() => import('./admin/AdminRoutes'));

export function App() {
  return (
    <Routes>
      <Route element={<PublicLayout />}>
        <Route index element={<HomePage />} />
        <Route path="umrah" element={<UmrahPage />} />
        <Route path="hotels" element={<HotelsPage />} />
        <Route path="flights" element={<FlightsPage />} />
        <Route path="visa" element={<VisaPage />} />
        <Route path="transport" element={<TransportPage />} />
        <Route path="faq" element={<FaqPage />} />
        <Route path="contact" element={<ContactPage />} />
        <Route path="policies/:policy" element={<PolicyPage />} />
      </Route>
      <Route
        path="/admin/*"
        element={
          <AdminLoadBoundary>
            <Suspense fallback={<p className="p-4">…</p>}>
              <AdminRoutes />
            </Suspense>
          </AdminLoadBoundary>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
