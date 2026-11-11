import { Router, type RequestHandler } from 'express';
import { makeAuthController } from './auth.controller.js';
import type { AuthContext } from './auth.service.js';

export function createAuthRouter(ctx: AuthContext, requireAuth: RequestHandler): Router {
  const controller = makeAuthController(ctx);
  const router = Router();

  router.post('/login', controller.login);
  router.post('/2fa', controller.twoFactor);
  router.post('/2fa/enroll', controller.enroll);
  router.post('/refresh', controller.refresh);
  router.post('/logout', controller.logout);
  router.get('/me', requireAuth, controller.me);

  return router;
}
