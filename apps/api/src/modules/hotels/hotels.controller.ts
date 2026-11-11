import {
  CreateHotelBodySchema,
  HotelListQuerySchema,
  MergeHotelBodySchema,
  UpdateHotelBodySchema,
} from '@marafiq/shared';
import type { Request, Response } from 'express';
import { actorOf } from '../../lib/actor.js';
import { parseOrThrow } from '../../lib/validate.js';
import {
  createHotel,
  deactivateHotel,
  getHotel,
  listHotels,
  mergeHotels,
  updateHotel,
} from './hotels.service.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await listHotels(parseOrThrow(HotelListQuerySchema, req.query)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(CreateHotelBodySchema, req.body);
  res.status(201).json(await createHotel(body, actorOf(req)));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await getHotel(idOf(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(UpdateHotelBodySchema, req.body);
  res.json(await updateHotel(idOf(req), body, actorOf(req)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  res.json(await deactivateHotel(idOf(req), actorOf(req)));
}

export async function merge(req: Request, res: Response): Promise<void> {
  const { targetId } = parseOrThrow(MergeHotelBodySchema, req.body);
  res.json(await mergeHotels(idOf(req), targetId, actorOf(req)));
}
