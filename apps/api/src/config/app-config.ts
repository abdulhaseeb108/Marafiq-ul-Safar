import type { Env } from './env.js';

/** Runtime settings passed into the app, so tests can build one without env vars. */
export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  jwtSecret: string;
  /** Keys the HMAC of refresh tokens; the database holds only the HMAC. */
  refreshSecret: string;
  /** 32-byte AES-256-GCM key for TOTP secrets. */
  totpKey: Buffer;
  cookieDomain?: string;
  secureCookies: boolean;
  /** Trust one reverse proxy hop for the client IP (rate limits, audit). */
  trustProxy: boolean;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** How long a "password OK, 2FA pending" step stays valid. */
  mfaTtlSeconds: number;
  totpIssuer: string;
  loginLimit: { maxFailures: number; windowMs: number };
}

export function configFromEnv(env: Env): AppConfig {
  const production = env.NODE_ENV === 'production';
  return {
    nodeEnv: env.NODE_ENV,
    jwtSecret: env.JWT_SECRET,
    refreshSecret: env.JWT_REFRESH_SECRET,
    totpKey: Buffer.from(env.TOTP_ENC_KEY, 'hex'),
    // A Domain attribute of "localhost" is rejected by some browsers; host-only is safer.
    cookieDomain:
      production && env.COOKIE_DOMAIN && env.COOKIE_DOMAIN !== 'localhost'
        ? env.COOKIE_DOMAIN
        : undefined,
    // Plain-http localhost cannot store Secure cookies in every browser.
    secureCookies: env.NODE_ENV !== 'development',
    trustProxy: production,
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 7 * 24 * 60 * 60,
    mfaTtlSeconds: 5 * 60,
    totpIssuer: 'Marafiq us Safar',
    loginLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
  };
}
