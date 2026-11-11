import { z } from 'zod';

/** Response of GET /api/v1/health. */
export const HealthResponseSchema = z.object({
  status: z.literal('ok'),
  service: z.string(),
  time: z.iso.datetime(),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

/** Error envelope for every API error (docs/02 section 4). */
export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
    fields: z.record(z.string(), z.string()).optional(),
  }),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;
