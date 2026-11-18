import { RATE_SHEET_MAX_BYTES } from '@marafiq/shared';
import { DEFAULT_PUBLIC_RATE_LIMITS, type PublicRateLimits } from '../lib/public-limits.js';
import { parseWebOrigins, type Env } from './env.js';
import type { DocumentParserLimits } from '../modules/document-intelligence/document-parser-limits.js';

/** The Vite dev server (apps/web/vite.config.ts: port 5175). */
const DEV_SITE_URL = 'http://localhost:5175';

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
  /**
   * Reverse proxies in front of the API, for the client IP (rate limits,
   * audit). A number is a hop count; false trusts none. Tests use true (one
   * hop) so they can pick a client IP with X-Forwarded-For.
   */
  trustProxy: boolean | number;
  /** Per-IP limits on /public; null turns them off (tests only). */
  publicRateLimits: PublicRateLimits | null;
  /** Origins allowed by CORS; empty for the same-origin deployment. */
  webOrigins: string[];
  /** When set, only requests carrying it (from the site proxy) are served. */
  originProxySecret?: string;
  accessTtlSeconds: number;
  refreshTtlSeconds: number;
  /** How long a "password OK, 2FA pending" step stays valid. */
  mfaTtlSeconds: number;
  totpIssuer: string;
  loginLimit: { maxFailures: number; windowMs: number };
  /** Largest rate sheet accepted, in bytes (docs/03 section 2: 20 MB). */
  maxUploadBytes: number;
  documentParserLimits: DocumentParserLimits;
  maxConcurrentDocumentUploads: number;
  /** Base URL for customer links, without a trailing slash. */
  publicSiteUrl: string;
  /** Staff inbox for notifications; none = no staff emails. */
  staffNotifyEmail?: string;
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
    trustProxy: production ? env.TRUST_PROXY_HOPS : false,
    publicRateLimits: DEFAULT_PUBLIC_RATE_LIMITS,
    webOrigins: parseWebOrigins(env.WEB_ORIGIN),
    originProxySecret: env.ORIGIN_PROXY_SECRET,
    accessTtlSeconds: 15 * 60,
    refreshTtlSeconds: 7 * 24 * 60 * 60,
    mfaTtlSeconds: 5 * 60,
    totpIssuer: 'Marafiq Us Safar',
    loginLimit: { maxFailures: 5, windowMs: 15 * 60 * 1000 },
    maxUploadBytes: RATE_SHEET_MAX_BYTES,
    documentParserLimits: {
      maxFileBytes: env.DOCUMENT_MAX_FILE_BYTES,
      maxPdfPages: env.DOCUMENT_MAX_PDF_PAGES,
      maxPdfPageTextBytes: env.DOCUMENT_MAX_PDF_PAGE_TEXT_BYTES,
      maxImageSide: env.DOCUMENT_MAX_IMAGE_SIDE,
      maxImagePixels: env.DOCUMENT_MAX_IMAGE_PIXELS,
      maxXlsxSheets: env.DOCUMENT_MAX_XLSX_SHEETS,
      maxXlsxCells: env.DOCUMENT_MAX_XLSX_CELLS,
      maxXlsxZipEntries: env.DOCUMENT_MAX_XLSX_ZIP_ENTRIES,
      maxXlsxUncompressedBytes: env.DOCUMENT_MAX_XLSX_UNCOMPRESSED_BYTES,
      maxXlsxEntryBytes: env.DOCUMENT_MAX_XLSX_ENTRY_BYTES,
      maxXlsxCompressionRatio: env.DOCUMENT_MAX_XLSX_COMPRESSION_RATIO,
      maxCsvRecords: env.DOCUMENT_MAX_CSV_RECORDS,
      maxCsvColumns: env.DOCUMENT_MAX_CSV_COLUMNS,
      maxCsvCells: env.DOCUMENT_MAX_CSV_CELLS,
      maxEvidenceRecords: env.DOCUMENT_MAX_EVIDENCE_RECORDS,
      maxEvidenceBytes: env.DOCUMENT_MAX_EVIDENCE_BYTES,
      evidenceChunkBytes: env.DOCUMENT_EVIDENCE_CHUNK_BYTES,
    },
    maxConcurrentDocumentUploads: env.DOCUMENT_MAX_CONCURRENT_UPLOADS,
    // env.ts requires an https value in production; elsewhere default to the dev site.
    publicSiteUrl: (env.PUBLIC_SITE_URL ?? DEV_SITE_URL).replace(/\/+$/, ''),
    staffNotifyEmail: env.STAFF_NOTIFY_EMAIL,
  };
}
