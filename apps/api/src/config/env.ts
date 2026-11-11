import { z } from 'zod';

/** .env files often have `KEY=` lines; treat blank as "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const secret = z.preprocess(
  blankToUndefined,
  z.string({ error: 'is required' }).min(32, 'must be at least 32 characters'),
);

/**
 * Variables the API needs so far. Later phases add theirs here
 * (R2, Resend, Anthropic, Sentry) with validation.
 */
const EnvSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().min(1).max(65535).default(4000),
    MONGODB_URI: z.preprocess(blankToUndefined, z.string({ error: 'is required' }).min(1)),
    JWT_SECRET: secret,
    JWT_REFRESH_SECRET: secret,
    /** 32-byte key as 64 hex characters; encrypts TOTP secrets at rest. */
    TOTP_ENC_KEY: z.preprocess(
      blankToUndefined,
      z.string({ error: 'is required' }).regex(/^[0-9a-fA-F]{64}$/, 'must be 64 hex characters'),
    ),
    COOKIE_DOMAIN: optionalString,
    SEED_ADMIN_EMAIL: optionalString,
    SEED_ADMIN_PASSWORD: optionalString,
  })
  .refine((env) => env.JWT_SECRET !== env.JWT_REFRESH_SECRET, {
    message: 'must differ from JWT_SECRET',
    path: ['JWT_REFRESH_SECRET'],
  });

export type Env = z.infer<typeof EnvSchema>;

export function loadEnv(
  source: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Env {
  const result = EnvSchema.safeParse(source);
  if (!result.success) {
    // Names and reasons only; never print the values.
    const problems = result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`);
    throw new Error(`Invalid environment (check .env):\n  ${problems.join('\n  ')}`);
  }
  return result.data;
}
