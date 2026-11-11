import type { AdminRoute } from '../../lib/admin-route.js';
import { get, put } from './settings.controller.js';

/** Admin only: markup and expiry change what every customer is quoted. */
export const settingsAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/settings', roles: ['admin'], handler: get },
  { method: 'put', path: '/settings', roles: ['admin'], handler: put },
];
