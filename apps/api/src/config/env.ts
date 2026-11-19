import { z } from 'zod';

/** .env files often have `KEY=` lines; treat blank as "not set". */
const blankToUndefined = (value: unknown) =>
  typeof value === 'string' && value.trim() === '' ? undefined : value;

const optionalString = z.preprocess(blankToUndefined, z.string().optional());
const positiveInteger = (fallback: number, maximum = Number.MAX_SAFE_INTEGER) =>
  z.preprocess(blankToUndefined, z.coerce.number().int().min(1).max(maximum).default(fallback));
const secret = z.preprocess(
  blankToUndefined,
  z.string({ error: 'is required' }).min(32, 'must be at least 32 characters'),
);

/**
 * Every variable the API reads, validated once at startup (docs/DEPLOY.md
 * lists them per environment).
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
    /** Rate sheet storage. All four set = Cloudflare R2; otherwise a local folder. */
    R2_ENDPOINT: optionalString,
    R2_ACCESS_KEY_ID: optionalString,
    R2_SECRET_ACCESS_KEY: optionalString,
    R2_BUCKET: optionalString,
    /** Rate sheet reading. Without a key, sheets are entered by hand. */
    ANTHROPIC_API_KEY: optionalString,
    /**
     * ClamAV (clamd) for document intelligence. Without it uploads are kept
     * but never parsed: the pipeline needs a clean scan first.
     */
    CLAMAV_HOST: optionalString,
    CLAMAV_PORT: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(1).max(65535).default(3310),
    ),
    EXTRACTION_MODEL: z.preprocess(blankToUndefined, z.string().default('claude-sonnet-5-5')),
    /** Email. Without a key, emails are only logged (never in production). */
    RESEND_API_KEY: optionalString,
    MAIL_FROM: optionalString,
    /** Where staff are told about new inquiries, accepted quotes and questions. Optional. */
    STAFF_NOTIFY_EMAIL: z.preprocess(blankToUndefined, z.email().optional()),
    /**
     * Base of the links in quote emails, e.g. https://example.com. Required in
     * production (https only, checked below); defaults to the dev site otherwise.
     */
    PUBLIC_SITE_URL: optionalString,
    /**
     * Comma-separated browser origins allowed to call the API across origins
     * (CORS). Blank when the site and API share one origin, the standard set-up.
     */
    WEB_ORIGIN: optionalString,
    /** Reverse proxies in front of the API in production (docs/DEPLOY.md). */
    TRUST_PROXY_HOPS: z.preprocess(
      blankToUndefined,
      z.coerce.number().int().min(0).max(5).default(1),
    ),
    /** Shared with the site's proxy; when set, requests that skip the proxy are refused. */
    ORIGIN_PROXY_SECRET: z.preprocess(
      blankToUndefined,
      z.string().min(32, 'must be at least 32 characters').optional(),
    ),
    /** Error reporting. Blank = off. */
    SENTRY_DSN: z.preprocess(blankToUndefined, z.url('must be a valid URL').optional()),
    SENTRY_RELEASE: optionalString,
    SEED_ADMIN_EMAIL: optionalString,
    SEED_ADMIN_PASSWORD: optionalString,
    DOCUMENT_MAX_FILE_BYTES: positiveInteger(20 * 1024 * 1024, 100 * 1024 * 1024),
    DOCUMENT_MAX_PDF_PAGES: positiveInteger(100, 1_000),
    DOCUMENT_MAX_PDF_PAGE_TEXT_BYTES: positiveInteger(1024 * 1024, 64 * 1024 * 1024),
    DOCUMENT_MAX_IMAGE_SIDE: positiveInteger(10_000, 50_000),
    DOCUMENT_MAX_IMAGE_PIXELS: positiveInteger(20_000_000, 500_000_000),
    DOCUMENT_MAX_XLSX_SHEETS: positiveInteger(20, 100),
    DOCUMENT_MAX_XLSX_CELLS: positiveInteger(200_000, 1_000_000),
    DOCUMENT_MAX_XLSX_ZIP_ENTRIES: positiveInteger(1_000, 10_000),
    DOCUMENT_MAX_XLSX_UNCOMPRESSED_BYTES: positiveInteger(64 * 1024 * 1024, 512 * 1024 * 1024),
    DOCUMENT_MAX_XLSX_ENTRY_BYTES: positiveInteger(16 * 1024 * 1024, 128 * 1024 * 1024),
    DOCUMENT_MAX_XLSX_COMPRESSION_RATIO: positiveInteger(250, 10_000),
    DOCUMENT_MAX_CSV_RECORDS: positiveInteger(100_000, 2_000_000),
    DOCUMENT_MAX_CSV_COLUMNS: positiveInteger(200, 10_000),
    DOCUMENT_MAX_CSV_CELLS: positiveInteger(1_000_000, 5_000_000),
    DOCUMENT_MAX_EVIDENCE_RECORDS: positiveInteger(10_000, 100_000),
    DOCUMENT_MAX_EVIDENCE_BYTES: positiveInteger(32 * 1024 * 1024, 256 * 1024 * 1024),
    DOCUMENT_EVIDENCE_CHUNK_BYTES: positiveInteger(48 * 1024, 64 * 1024),
    DOCUMENT_MAX_CONCURRENT_UPLOADS: positiveInteger(2, 8),
  })
  .refine((env) => env.JWT_SECRET !== env.JWT_REFRESH_SECRET, {
    message: 'must differ from JWT_SECRET',
    path: ['JWT_REFRESH_SECRET'],
  })
  .superRefine((env, context) => {
    if (env.DOCUMENT_MAX_XLSX_ENTRY_BYTES > env.DOCUMENT_MAX_XLSX_UNCOMPRESSED_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'must not exceed DOCUMENT_MAX_XLSX_UNCOMPRESSED_BYTES',
        path: ['DOCUMENT_MAX_XLSX_ENTRY_BYTES'],
      });
    }
    if (env.DOCUMENT_EVIDENCE_CHUNK_BYTES > env.DOCUMENT_MAX_EVIDENCE_BYTES) {
      context.addIssue({
        code: 'custom',
        message: 'must not exceed DOCUMENT_MAX_EVIDENCE_BYTES',
        path: ['DOCUMENT_EVIDENCE_CHUNK_BYTES'],
      });
    }
    if (env.RESEND_API_KEY && !env.MAIL_FROM) {
      context.addIssue({
        code: 'custom',
        message: 'is required when RESEND_API_KEY is set',
        path: ['MAIL_FROM'],
      });
    }
    const originProblem = webOriginsProblem(env.WEB_ORIGIN, env.NODE_ENV);
    if (originProblem) {
      context.addIssue({ code: 'custom', message: originProblem, path: ['WEB_ORIGIN'] });
    }
    // The origin lock only admits requests from the site's proxy. In a split
    // deployment browsers call the API directly and cannot carry the secret,
    // so every request (and every CORS preflight) would be refused.
    if (env.ORIGIN_PROXY_SECRET && parseWebOrigins(env.WEB_ORIGIN).length > 0) {
      context.addIssue({
        code: 'custom',
        message:
          'cannot be used with WEB_ORIGIN: browsers calling the API directly cannot send the proxy secret. Use one set-up or the other (docs/DEPLOY.md)',
        path: ['ORIGIN_PROXY_SECRET'],
      });
    }
    const siteUrlProblem = publicSiteUrlProblem(env.PUBLIC_SITE_URL, env.NODE_ENV);
    if (siteUrlProblem) {
      context.addIssue({ code: 'custom', message: siteUrlProblem, path: ['PUBLIC_SITE_URL'] });
    }
  });

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]', '0.0.0.0']);

/**
 * Customer quote links are built from PUBLIC_SITE_URL, so in production it must
 * be a real https address customers can open. Returns the problem, or null.
 */
function publicSiteUrlProblem(value: string | undefined, nodeEnv: string): string | null {
  if (value === undefined) return nodeEnv === 'production' ? 'is required in production' : null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return 'must be a valid URL';
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return 'must be an http(s) URL';
  if (url.username || url.password || url.search || url.hash) {
    return 'must not contain credentials, a query or a fragment';
  }
  if (nodeEnv === 'production') {
    if (url.protocol !== 'https:') return 'must use https in production';
    if (LOCAL_HOSTS.has(url.hostname)) return 'must not be a local address in production';
  }
  return null;
}

/** WEB_ORIGIN as a list; empty when not set. */
export function parseWebOrigins(value: string | undefined): string[] {
  return (value ?? '')
    .split(',')
    .map((origin) => origin.trim())
    .filter((origin) => origin !== '');
}

/**
 * Each entry must be a bare origin (scheme, host, optional port), exactly as a
 * browser sends it in the Origin header; https only in production.
 */
function webOriginsProblem(value: string | undefined, nodeEnv: string): string | null {
  for (const origin of parseWebOrigins(value)) {
    let url: URL;
    try {
      url = new URL(origin);
    } catch {
      return `"${origin}" is not a valid origin`;
    }
    if (url.origin !== origin) {
      return `"${origin}" must be an origin only, e.g. https://example.com (no path or trailing slash)`;
    }
    if (nodeEnv === 'production' && url.protocol !== 'https:') {
      return 'must use https in production';
    }
  }
  return null;
}

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
