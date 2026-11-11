import type { AdminRoute } from '../../lib/admin-route.js';
import { getAudit } from './audit.controller.js';

export const auditAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/audit', roles: ['admin'], handler: getAudit },
];
