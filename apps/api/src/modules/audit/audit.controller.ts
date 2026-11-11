import { AuditQuerySchema } from '@marafiq/shared';
import type { Request, Response } from 'express';
import { parseOrThrow } from '../../lib/validate.js';
import { listAudit } from './audit.service.js';

export async function getAudit(req: Request, res: Response): Promise<void> {
  const query = parseOrThrow(AuditQuerySchema, req.query);
  res.json(await listAudit(query));
}
