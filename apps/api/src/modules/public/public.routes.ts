import { Router } from 'express';
import { getConfig } from './public.controller.js';

/** Open to anyone. Public routes are rate limited in Phase 7. */
export const publicRouter = Router();

publicRouter.get('/config', getConfig);
