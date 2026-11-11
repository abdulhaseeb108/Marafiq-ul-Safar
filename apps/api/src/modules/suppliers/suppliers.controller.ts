import {
  CreateSupplierBodySchema,
  ListQuerySchema,
  UpdateSupplierBodySchema,
} from '@marafiq/shared';
import type { Request, Response } from 'express';
import { actorOf } from '../../lib/actor.js';
import { parseOrThrow } from '../../lib/validate.js';
import {
  createSupplier,
  deactivateSupplier,
  getSupplier,
  listSuppliers,
  updateSupplier,
} from './suppliers.service.js';

const idOf = (req: Request): string => String(req.params.id ?? '');

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await listSuppliers(parseOrThrow(ListQuerySchema, req.query)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(CreateSupplierBodySchema, req.body);
  res.status(201).json(await createSupplier(body, actorOf(req)));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await getSupplier(idOf(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(UpdateSupplierBodySchema, req.body);
  res.json(await updateSupplier(idOf(req), body, actorOf(req)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  res.json(await deactivateSupplier(idOf(req), actorOf(req)));
}
