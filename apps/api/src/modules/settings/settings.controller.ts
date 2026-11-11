import { UpdateSettingsBodySchema } from '@marafiq/shared';
import type { Request, Response } from 'express';
import { actorOf } from '../../lib/actor.js';
import { parseOrThrow } from '../../lib/validate.js';
import { getSettings, updateSettings } from './settings.service.js';

export async function get(_req: Request, res: Response): Promise<void> {
  res.json(await getSettings());
}

export async function put(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(UpdateSettingsBodySchema, req.body);
  res.json(await updateSettings(body, actorOf(req)));
}
