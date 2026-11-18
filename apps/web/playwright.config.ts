/**
 * Browser tests for the public site (docs/04 Phase 5). The API is mocked inside
 * each test, so only the built web app is served.
 *
 * Run: npm run e2e (from the repo root). First time on a new machine:
 *   npx playwright install chromium
 * Or use an installed Chrome instead: PW_CHANNEL=chrome npm run e2e
 */
import { defineConfig, devices } from '@playwright/test';

const PORT = 4179;

export default defineConfig({
  testDir: './e2e',
  timeout: 30_000,
  fullyParallel: true,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://localhost:${PORT}`,
    channel: process.env.PW_CHANNEL || undefined,
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'mobile-360',
      use: {
        ...devices['Pixel 5'],
        viewport: { width: 360, height: 740 },
        browserName: 'chromium',
      },
    },
  ],
  webServer: {
    command: `npx vite preview --port ${PORT} --strictPort`,
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
    timeout: 60_000,
  },
});
