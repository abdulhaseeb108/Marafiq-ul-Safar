import type { AdminRoute } from '../../lib/admin-route.js';
import { create, deactivate, getOne, list, merge, update } from './hotels.controller.js';

/**
 * Every staff role may read hotels (sales and finance need them for quotes);
 * only admin and ops may change them (docs/02 section 3).
 */
export const hotelsAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/hotels', roles: ['admin', 'sales', 'ops', 'finance'], handler: list },
  { method: 'post', path: '/hotels', roles: ['admin', 'ops'], handler: create },
  {
    method: 'get',
    path: '/hotels/:id',
    roles: ['admin', 'sales', 'ops', 'finance'],
    handler: getOne,
  },
  { method: 'patch', path: '/hotels/:id', roles: ['admin', 'ops'], handler: update },
  { method: 'post', path: '/hotels/:id/deactivate', roles: ['admin', 'ops'], handler: deactivate },
  { method: 'post', path: '/hotels/:id/merge', roles: ['admin', 'ops'], handler: merge },
];
