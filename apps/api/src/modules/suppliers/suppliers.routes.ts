import type { AdminRoute } from '../../lib/admin-route.js';
import { create, deactivate, getOne, list, update } from './suppliers.controller.js';

/** Admin and ops (docs/02 section 3). No delete: deactivate instead. */
export const suppliersAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/suppliers', roles: ['admin', 'ops'], handler: list },
  { method: 'post', path: '/suppliers', roles: ['admin', 'ops'], handler: create },
  { method: 'get', path: '/suppliers/:id', roles: ['admin', 'ops'], handler: getOne },
  { method: 'patch', path: '/suppliers/:id', roles: ['admin', 'ops'], handler: update },
  {
    method: 'post',
    path: '/suppliers/:id/deactivate',
    roles: ['admin', 'ops'],
    handler: deactivate,
  },
];
