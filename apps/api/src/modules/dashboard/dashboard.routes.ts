/**
 * Staff dashboard (docs/01 section 6.2). Every staff role may open it; the
 * service leaves out the sections a role may not see (docs/02 section 3).
 */
import { ROLES } from '@marafiq/shared';
import type { Request, Response } from 'express';
import type { AdminRoute } from '../../lib/admin-route.js';
import { unauthenticated } from '../../lib/http-error.js';
import { getDashboard } from './dashboard.service.js';

export const dashboardAdminRoutes: AdminRoute[] = [
  {
    method: 'get',
    path: '/dashboard',
    roles: ROLES,
    handler: async (req: Request, res: Response) => {
      if (!req.auth) throw unauthenticated();
      res.set('Cache-Control', 'no-store');
      res.json(await getDashboard(req.auth.role));
    },
  },
];
