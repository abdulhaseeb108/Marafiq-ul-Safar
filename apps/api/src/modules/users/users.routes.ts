import type { AdminRoute } from '../../lib/admin-route.js';
import {
  create,
  deactivate,
  getOne,
  list,
  resetUserTwoFactor,
  update,
} from './users.controller.js';

/** Admin only (docs/02 section 3). There is deliberately no DELETE route. */
export const usersAdminRoutes: AdminRoute[] = [
  { method: 'get', path: '/users', roles: ['admin'], handler: list },
  { method: 'post', path: '/users', roles: ['admin'], handler: create },
  { method: 'get', path: '/users/:id', roles: ['admin'], handler: getOne },
  { method: 'patch', path: '/users/:id', roles: ['admin'], handler: update },
  { method: 'post', path: '/users/:id/deactivate', roles: ['admin'], handler: deactivate },
  { method: 'post', path: '/users/:id/reset-2fa', roles: ['admin'], handler: resetUserTwoFactor },
];
