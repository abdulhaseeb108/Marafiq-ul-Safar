/**
 * Browser tests for the public site and the full quote flow.
 *
 *   npm run e2e       Phone layout, both languages, keyboard. The API is mocked.
 *   npm run e2e:flow  The whole flow against a real API and database
 *                     (docs/04 Phase 6). Needs MongoDB; set E2E_MONGODB_URI to a
 *                     database named exactly "marafiq_e2e" (it is wiped each run)
 *                     and set E2E_ALLOW_DB_RESET=true to confirm. The flag is not
 *                     set here on purpose: whoever runs the flow must set it.
 *                     Uses playwright.flow.config.ts (no shell variables, so it
 *                     also works in Windows cmd and PowerShell).
 *
 * First time on a new machine: npx playwright install chromium
 * Or use an installed Chrome instead: PW_CHANNEL=chrome npm run e2e
 */
import { defineConfig, devices } from '@playwright/test';

const WEB_PORT = 4179;
const API_PORT = 4011;

/** A throwaway API for the flow test: no real email, no rate-sheet reading, no R2. */
const apiEnv = (MONGODB_URI: string) => ({
  NODE_ENV: 'development',
  PORT: String(API_PORT),
  MONGODB_URI,
  JWT_SECRET: 'e2e-access-secret-e2e-access-secret-0001',
  JWT_REFRESH_SECRET: 'e2e-refresh-secret-e2e-refresh-secret-02',
  TOTP_ENC_KEY: '0'.repeat(63) + '1',
  PUBLIC_SITE_URL: `http://localhost:${WEB_PORT}`,
  // Blank values win over anything in the repository's .env.
  COOKIE_DOMAIN: '',
  SENTRY_DSN: '',
  RESEND_API_KEY: '',
  MAIL_FROM: '',
  STAFF_NOTIFY_EMAIL: '',
  ANTHROPIC_API_KEY: '',
  R2_ENDPOINT: '',
  R2_ACCESS_KEY_ID: '',
  R2_SECRET_ACCESS_KEY: '',
  R2_BUCKET: '',
  SEED_ADMIN_EMAIL: '',
  SEED_ADMIN_PASSWORD: '',
});

/** The API binds to 127.0.0.1 in development, so address it by IP (not "localhost"). */
const API_URL = `http://127.0.0.1:${API_PORT}`;

export function playwrightConfig(flow: boolean) {
  const FLOW = flow;
  const MONGODB_URI = process.env.E2E_MONGODB_URI ?? 'mongodb://127.0.0.1:27017/marafiq_e2e';
  return defineConfig({
    testDir: './e2e',
    timeout: FLOW ? 90_000 : 30_000,
    fullyParallel: !FLOW,
    reporter: process.env.CI ? 'github' : 'list',
    use: {
      baseURL: `http://localhost:${WEB_PORT}`,
      channel: process.env.PW_CHANNEL || undefined,
      trace: 'retain-on-failure',
    },
    projects: FLOW
      ? [
          {
            name: 'flow',
            testMatch: /flow\.spec\.ts/,
            use: { ...devices['Desktop Chrome'], browserName: 'chromium' },
          },
        ]
      : [
          {
            name: 'mobile-360',
            testIgnore: /flow\.spec\.ts/,
            use: {
              ...devices['Pixel 5'],
              viewport: { width: 360, height: 740 },
              browserName: 'chromium',
            },
          },
        ],
    webServer: [
      ...(FLOW
        ? [
            {
              command: 'npx tsx src/scripts/e2e-seed.ts && npx tsx src/server.ts',
              cwd: '../api',
              url: `${API_URL}/api/v1/health`,
              env: apiEnv(MONGODB_URI),
              reuseExistingServer: false,
              timeout: 120_000,
            },
          ]
        : []),
      {
        command: `npx vite preview --port ${WEB_PORT} --strictPort`,
        url: `http://localhost:${WEB_PORT}`,
        env: FLOW ? { VITE_API_PROXY: API_URL } : {},
        reuseExistingServer: !process.env.CI && !FLOW,
        timeout: 60_000,
      },
    ],
  });
}

export default playwrightConfig(false);
