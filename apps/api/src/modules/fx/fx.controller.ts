import { CreateFxBodySchema, ListQuerySchema } from '@marafiq/shared';
import type { Request, Response } from 'express';
import { actorOf } from '../../lib/actor.js';
import { parseOrThrow } from '../../lib/validate.js';
import { createFxRate, listFxRates } from './fx.service.js';

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await listFxRates(parseOrThrow(ListQuerySchema, req.query)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(CreateFxBodySchema, req.body);
  res.status(201).json(await createFxRate(body, actorOf(req)));
}
