import { Router } from 'express';
import { getConfig, getHotels, postCalculate } from './public.controller.js';

/** Open to anyone. Public routes are rate limited in Phase 7. */
export const publicRouter = Router();

publicRouter.get('/config', getConfig);
publicRouter.get('/hotels', getHotels);
publicRouter.post('/calculate', postCalculate);
