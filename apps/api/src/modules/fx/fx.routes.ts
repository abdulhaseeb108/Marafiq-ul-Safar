import type { AdminRoute } from '../../lib/admin-route.js';
import { create, list } from './fx.controller.js';

/**
 * Admin only. There is deliberately no update or delete route: the FX history
 * is append-only (CLAUDE.md hard rule 4).
 */
export const fxAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/fx', roles: ['admin'], handler: list },
  { method: 'post', path: '/fx', roles: ['admin'], handler: create },
];
