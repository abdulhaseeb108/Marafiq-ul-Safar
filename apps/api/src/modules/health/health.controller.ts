import type { HealthResponse } from '@marafiq/shared';
import type { Request, Response } from 'express';

export function getHealth(_req: Request, res: Response<HealthResponse>): void {
  res.status(200).json({
    status: 'ok',
    service: 'marafiq-api',
    time: new Date().toISOString(),
  });
}
