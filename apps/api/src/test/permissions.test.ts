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
import {
  makeApp,
  seedFlightEstimate,
  seedHotel,
  seedSupplier,
  seedUser,
  signInWithRole,
  TEST_PASSWORD,
} from './helpers.js';

type Method = 'get' | 'post' | 'patch' | 'put';

interface RouteContext {
  userId: string;
  supplierId: string;
  hotelId: string;
  duplicateHotelId: string;
  flightEstimateId: string;
}

interface ProtectedRoute {
  method: Method;
  /** Express path pattern, as mounted. */
  pattern: string;
  allowed: readonly Role[];
  /** Which seeded entity fills :id. Defaults to the user. */
  id?: (ctx: RouteContext) => string;
  body?: (ctx: RouteContext) => object;
}

const ANY_STAFF = ROLES;
const ADMIN_ONLY = ['admin'] as const;
const ADMIN_OPS = ['admin', 'ops'] as const;

const PROTECTED_ROUTES: ProtectedRoute[] = [
  { method: 'get', pattern: '/api/v1/auth/me', allowed: ANY_STAFF },

  // users (Phase 1)
  { method: 'get', pattern: '/api/v1/admin/users', allowed: ADMIN_ONLY },
  {
    method: 'post',
    pattern: '/api/v1/admin/users',
    allowed: ADMIN_ONLY,
    body: () => ({
      email: `new${Date.now()}@example.com`,
      name: 'New User',
      role: 'ops',
      password: TEST_PASSWORD,
    }),
  },
  { method: 'get', pattern: '/api/v1/admin/users/:id', allowed: ADMIN_ONLY },
  {
    method: 'patch',
    pattern: '/api/v1/admin/users/:id',
    allowed: ADMIN_ONLY,
    body: () => ({ name: 'Renamed' }),
  },
  { method: 'post', pattern: '/api/v1/admin/users/:id/deactivate', allowed: ADMIN_ONLY },
  { method: 'post', pattern: '/api/v1/admin/users/:id/reset-2fa', allowed: ADMIN_ONLY },
  { method: 'get', pattern: '/api/v1/admin/audit', allowed: ADMIN_ONLY },

  // suppliers
  { method: 'get', pattern: '/api/v1/admin/suppliers', allowed: ADMIN_OPS },
  {
    method: 'post',
    pattern: '/api/v1/admin/suppliers',
    allowed: ADMIN_OPS,
    body: () => ({ name: `Supplier ${Math.random()}`, type: 'hotel_operator' }),
  },
  {
    method: 'get',
    pattern: '/api/v1/admin/suppliers/:id',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.supplierId,
  },
  {
    method: 'patch',
    pattern: '/api/v1/admin/suppliers/:id',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.supplierId,
    body: () => ({ notes: 'Called about rates' }),
  },
  {
    method: 'post',
    pattern: '/api/v1/admin/suppliers/:id/deactivate',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.supplierId,
  },

  // hotels: every staff role may read, only admin and ops may write
  { method: 'get', pattern: '/api/v1/admin/hotels', allowed: ANY_STAFF },
  {
    method: 'get',
    pattern: '/api/v1/admin/hotels/:id',
    allowed: ANY_STAFF,
    id: (ctx) => ctx.hotelId,
  },
  {
    method: 'post',
    pattern: '/api/v1/admin/hotels',
    allowed: ADMIN_OPS,
    body: () => ({ city: 'makkah', canonicalName: `Hotel ${Math.random()}` }),
  },
  {
    method: 'patch',
    pattern: '/api/v1/admin/hotels/:id',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.hotelId,
    body: () => ({ distanceNote: 'Shahra Ajiad' }),
  },
  {
    method: 'post',
    pattern: '/api/v1/admin/hotels/:id/deactivate',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.hotelId,
  },
  {
    method: 'post',
    pattern: '/api/v1/admin/hotels/:id/merge',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.duplicateHotelId,
    body: (ctx) => ({ targetId: ctx.hotelId }),
  },

  // settings and FX: admin only
  { method: 'get', pattern: '/api/v1/admin/settings', allowed: ADMIN_ONLY },
  {
    method: 'put',
    pattern: '/api/v1/admin/settings',
    allowed: ADMIN_ONLY,
    body: () => ({ markupPercent: 0 }),
  },
  { method: 'get', pattern: '/api/v1/admin/fx', allowed: ADMIN_ONLY },
  {
    method: 'post',
    pattern: '/api/v1/admin/fx',
    allowed: ADMIN_ONLY,
    body: () => ({ rate: '75.00' }),
  },

  // flight estimates
  { method: 'get', pattern: '/api/v1/admin/flight-estimates', allowed: ADMIN_OPS },
  {
    method: 'post',
    pattern: '/api/v1/admin/flight-estimates',
    allowed: ADMIN_OPS,
    body: () => ({
      originCity: `City ${Math.random()}`,
      destination: 'JED',
      lowMinor: 15_000_000,
      highMinor: 21_000_000,
      validTo: '2027-12-31',
      source: 'partner quote',
    }),
  },
  {
    method: 'get',
    pattern: '/api/v1/admin/flight-estimates/:id',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.flightEstimateId,
  },
  {
    method: 'patch',
    pattern: '/api/v1/admin/flight-estimates/:id',
    allowed: ADMIN_OPS,
    id: (ctx) => ctx.flightEstimateId,
    body: () => ({ note: 'Updated note' }),
  },
];

function send(app: Express, route: ProtectedRoute, ctx: RouteContext, cookie?: string) {
  const path = route.pattern.replace(':id', route.id ? route.id(ctx) : ctx.userId);
  let req = request(app)[route.method](path);
  if (cookie) req = req.set('Cookie', cookie);
  return route.body ? req.send(route.body(ctx)) : req;
}

describe('permission sweep', () => {
  let app: Express;
  let ctx: RouteContext;

  beforeEach(async () => {
    app = makeApp().app;
    const [user, supplier, hotel, duplicate, flight] = await Promise.all([
      seedUser({ role: 'finance', email: 'target@example.com' }),
      seedSupplier(),
      seedHotel({ canonicalName: 'Qila Ajiyad' }),
      seedHotel({ canonicalName: 'Qila Ajyad Old' }),
      seedFlightEstimate(),
    ]);
    ctx = {
      userId: user.id,
      supplierId: supplier.id,
      hotelId: hotel.id,
      duplicateHotelId: duplicate.id,
      flightEstimateId: flight.id,
    };
  });

  it('lists every route mounted under /admin', () => {
    const listed = PROTECTED_ROUTES.filter((r) => r.pattern.startsWith('/api/v1/admin')).map(
      (r) => `${r.method.toUpperCase()} ${r.pattern}`,
    );
    expect(listAdminRoutes().sort()).toEqual(listed.sort());
  });

  describe.each(PROTECTED_ROUTES)('$method $pattern', (route) => {
    it('returns 401 without a token', async () => {
      const res = await send(app, route, ctx);
      expect(res.status).toBe(401);
      expect(res.body.error.code).toBe('unauthenticated');
    });

    it('returns 401 for a garbage token', async () => {
      const res = await send(app, route, ctx, 'msf_access=not-a-jwt');
      expect(res.status).toBe(401);
    });

    const denied = ROLES.filter((role) => !route.allowed.includes(role));
    if (denied.length > 0) {
      it.each(denied)('returns 403 for role %s', async (role) => {
        const { jar } = await signInWithRole(app, role);
        const res = await send(app, route, ctx, jar.header());
        expect(res.status).toBe(403);
        expect(res.body.error.code).toBe('forbidden');
      });
    }

    it.each([...route.allowed])('succeeds for role %s', async (role) => {
      const { jar } = await signInWithRole(app, role);
      const res = await send(app, route, ctx, jar.header());
      expect(res.status).toBeGreaterThanOrEqual(200);
      expect(res.status).toBeLessThan(300);
    });
  });

  it('keeps public routes open', async () => {
    expect((await request(app).get('/api/v1/health')).status).toBe(200);
    expect((await request(app).get('/api/v1/public/config')).status).toBe(200);
  });
});
