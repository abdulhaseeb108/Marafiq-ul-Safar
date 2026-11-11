import type { AdminRoute } from '../../lib/admin-route.js';
import { create, getOne, list, update } from './flight-estimates.controller.js';

/**
 * Admin and ops. No delete route: a row that should no longer be offered gets
 * a validTo in the past, which keeps the history of what was quoted.
 */
export const flightEstimatesAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/flight-estimates', roles: ['admin', 'ops'], handler: list },
  { method: 'post', path: '/flight-estimates', roles: ['admin', 'ops'], handler: create },
  { method: 'get', path: '/flight-estimates/:id', roles: ['admin', 'ops'], handler: getOne },
  { method: 'patch', path: '/flight-estimates/:id', roles: ['admin', 'ops'], handler: update },
];
