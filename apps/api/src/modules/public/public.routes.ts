import {
  InquiryBodySchema,
  PublicQuoteMessageBodySchema,
  PublicQuoteQuerySchema,
} from '@marafiq/shared';
import { Router, type Request, type Response } from 'express';
import { parseOrThrow } from '../../lib/validate.js';
import { createInquiry, type LeadsDeps } from '../leads/leads.service.js';
import { acceptPublicQuote, askAboutPublicQuote, getPublicQuote } from '../leads/quotes.service.js';
import { getConfig, getHotels, postCalculate } from './public.controller.js';

const following = (req: Request) =>
  parseOrThrow(PublicQuoteQuerySchema, req.query).follow === 'latest';
const token = (req: Request) => String(req.params.token);

/** Open to anyone. Public routes are rate limited in Phase 7. */
export function createPublicRouter(deps: LeadsDeps): Router {
  const router = Router();
  router.get('/config', getConfig);
  router.get('/hotels', getHotels);
  router.post('/calculate', postCalculate);

  router.post('/inquiries', async (req: Request, res: Response) => {
    const body = parseOrThrow(InquiryBodySchema, req.body);
    res.status(201).json(await createInquiry(body, { ip: req.ip }, deps));
  });

  // Customer quote links. The token is the only key; see quotes.service.ts.
  router.get('/quotes/:token', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(await getPublicQuote(token(req), following(req)));
  });
  router.post('/quotes/:token/accept', async (req: Request, res: Response) => {
    res.set('Cache-Control', 'no-store');
    res.json(await acceptPublicQuote(token(req), following(req), { ip: req.ip }, deps));
  });
  router.post('/quotes/:token/message', async (req: Request, res: Response) => {
    const { body } = parseOrThrow(PublicQuoteMessageBodySchema, req.body);
    await askAboutPublicQuote(token(req), following(req), body, { ip: req.ip }, deps);
    res.status(201).json({ ok: true });
  });
  return router;
}
