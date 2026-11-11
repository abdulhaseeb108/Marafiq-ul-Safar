import { CreateUserBodySchema, ListQuerySchema, UpdateUserBodySchema } from '@marafiq/shared';
import type { Request, Response } from 'express';
import { unauthenticated } from '../../lib/http-error.js';
import { parseOrThrow } from '../../lib/validate.js';
import {
  createUser,
  deactivateUser,
  getUser,
  listUsers,
  resetTwoFactor,
  updateUser,
  type Actor,
} from './users.service.js';

function actorOf(req: Request): Actor {
  if (!req.auth) throw unauthenticated();
  return { id: req.auth.userId, role: req.auth.role, ip: req.ip };
}

const idOf = (req: Request): string => String(req.params.id ?? '');

export async function list(req: Request, res: Response): Promise<void> {
  res.json(await listUsers(parseOrThrow(ListQuerySchema, req.query)));
}

export async function create(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(CreateUserBodySchema, req.body);
  res.status(201).json(await createUser(body, actorOf(req)));
}

export async function getOne(req: Request, res: Response): Promise<void> {
  res.json(await getUser(idOf(req)));
}

export async function update(req: Request, res: Response): Promise<void> {
  const body = parseOrThrow(UpdateUserBodySchema, req.body);
  res.json(await updateUser(idOf(req), body, actorOf(req)));
}

export async function deactivate(req: Request, res: Response): Promise<void> {
  res.json(await deactivateUser(idOf(req), actorOf(req)));
}

export async function resetUserTwoFactor(req: Request, res: Response): Promise<void> {
  res.json(await resetTwoFactor(idOf(req), actorOf(req)));
}
