import { z } from 'zod';

/**
 * Only the variables Phase 0 needs. Each later phase adds the variables it
 * uses (Mongo, JWT, R2, Resend, Anthropic, Sentry) with validation here.
 */
const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(4002),
});

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(source: NodeJS.ProcessEnv = process.env): Env {
  return EnvSchema.parse(source);
}
