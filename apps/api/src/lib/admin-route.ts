import type { Role } from '@marafiq/shared';
import type { RequestHandler } from 'express';

/**
 * Every /admin route is declared with the roles allowed to call it. The app
 * mounts these behind requireAuth + requireRole, so a route cannot exist
 * without a role check (CLAUDE.md hard rule 7).
 */
export interface AdminRoute {
  method: 'get' | 'post' | 'patch' | 'put' | 'delete';
  /** Path under /api/v1/admin, e.g. "/users/:id". */
  path: string;
  roles: readonly [Role, ...Role[]];
  handler: RequestHandler;
}
