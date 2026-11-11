import type { Request } from 'express';
import type { Actor } from '../modules/audit/audit.service.js';
import { unauthenticated } from './http-error.js';

/** Who is making this request, for audit events. Use after requireAuth. */
export function actorOf(req: Request): Actor {
  if (!req.auth) throw unauthenticated();
  return { id: req.auth.userId, role: req.auth.role, ip: req.ip };
}

/** The system itself, for the seed script and scheduled jobs. */
export const SYSTEM_ACTOR: Actor = { role: 'system' };
