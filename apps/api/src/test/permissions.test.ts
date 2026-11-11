/**
 * Permission sweep (docs/02 section 3). Every protected route must be listed
 * here: no token -> 401, wrong role -> 403, allowed role -> success.
 * A second test fails if a route is mounted under /admin but missing below.
 */
import { ROLES, type Role } from '@marafiq/shared';
import type { Express } from 'express';
import request from 'supertest';
import { beforeEach, describe, expect, it } from 'vitest';
import { listAdminRoutes } from '../app.js';
import { makeApp, seedUser, signInWithRole, TEST_PASSWORD } from './helpers.js';

type Method = 'get' | 'post' | 'patch';

interface ProtectedRoute {
  method: Method;
  /** Express path pattern, as mounted. */
  pattern: string;
  allowed: readonly Role[];
  body?: (targetId: string) => object;
}

const ANY_STAFF = ROLES;

const PROTECTED_ROUTES: ProtectedRoute[] = [
  { method: 'get', pattern: '/api/v1/auth/me', allowed: ANY_STAFF },
  { method: 'get', pattern: '/api/v1/admin/users', allowed: ['admin'] },
  {
    method: 'post',
    pattern: '/api/v1/admin/users',
    allowed: ['admin'],
    body: () => ({
      email: `new${Date.now()}@example.com`,
      name: 'New User',
      role: 'ops',
      password: TEST_PASSWORD,
    }),
  },
  { method: 'get', pattern: '/api/v1/admin/users/:id', allowed: ['admin'] },
  {
    method: 'patch',
    pattern: '/api/v1/admin/users/:id',
    allowed: ['admin'],
    body: () => ({ name: 'Renamed' }),
  },
  { method: 'post', pattern: '/api/v1/admin/users/:id/deactivate', allowed: ['admin'] },
  { method: 'post', pattern: '/api/v1/admin/users/:id/reset-2fa', allowed: ['admin'] },
  { method: 'get', pattern: '/api/v1/admin/audit', allowed: ['admin'] },
];

function send(app: Express, route: ProtectedRoute, targetId: string, cookie?: string) {
  const path = route.pattern.replace(':id', targetId);
  let req = request(app)[route.method](path);
  if (cookie) req = req.set('Cookie', cookie);
  return route.body ? req.send(route.body(targetId)) : req;
}

describe('permission sweep', () => {
  let app: Express;
  let targetId: string;

  beforeEach(async () => {
    app = makeApp().app;
    targetId = (await seedUser({ role: 'finance', email: 'target@example.com' })).id;
  });

  it('lists every route mounted under /admin', () => {
    const listed = PROTECTED_ROUTES.filter((r) => r.pattern.startsWith('/api/v1/admin')).map(
      (r) => `${r.method.toUpperCase()} ${r.pattern}`,
    );
    expect(listAdminRoutes().sort()).toEqual(listed.sort());
  });

  describe.each(PROTECTED_ROUTES)('$method $pattern', (route) => {
    it('returns 401 without a token', async () => {
      const res = await send(app, route, targetId);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('returns 401 for a garbage token', async () => {
      const res = await send(app, route, targetId, 'msf_access=not-a-jwt');
      expect(res.status).toBe(401);
    });

    const denied = ROLES.filter((role) => !route.allowed.includes(role));
    it.each(denied)('returns 403 for role %s', async (role) => {
      const { jar } = await signInWithRole(app, role);
      const res = await send(app, route, targetId, jar.header());
      expect(res.status).toBe(403);
      expect(res.body.error.code).toBe('forbidden');
    });

    it.each([...route.allowed])('succeeds for role %s', async (role) => {
      const { jar } = await signInWithRole(app, role);
      const res = await send(app, route, targetId, jar.header());
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });

  it('keeps public routes open', async () => {
    const res = await request(app).get('/api/v1/health');
    expect(res.status).toBe(200);
  });
});
