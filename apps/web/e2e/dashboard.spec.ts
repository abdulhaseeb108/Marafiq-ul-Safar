/**
 * Staff dashboard (FEAT-01) in a real browser: one column on a 360px phone with
 * nothing scrolling sideways (English and Urdu), two columns on a wide screen.
 * The API is mocked.
 */
import type { DashboardSummary, PublicUser } from '@marafiq/shared';
import { expect, test, type Page } from '@playwright/test';
import en from '../src/locales/en.json' with { type: 'json' };
import ur from '../src/locales/ur.json' with { type: 'json' };

const admin: PublicUser = {
  id: '64b7f0c2a1b2c3d4e5f60718',
  email: 'admin@example.com',
  name: 'Test admin',
  role: 'admin',
  active: true,
  twoFactorEnabled: true,
  lastLoginAt: null,
  createdAt: new Date('2026-11-11T00:00:00Z'),
};

const summary: DashboardSummary = {
  generatedAt: '2026-11-17T10:00:00.000Z',
  leads: { newCount: 4 },
  quotes: {
    windowHours: 48,
    expiringCount: 1,
    expiring: [
      {
        quoteId: '64b7f0c2a1b2c3d4e5f6c001',
        leadId: '64b7f0c2a1b2c3d4e5f6e001',
        leadReference: 'MSF-2026-000123',
        version: 2,
        expiresAt: '2026-11-18T18:59:59.999Z',
      },
    ],
  },
  rates: {
    windowDays: 14,
    expiringCount: 1,
    expiring: [
      {
        packageId: '64b7f0c2a1b2c3d4e5f6d001',
        packName: 'A long supplier pack name that has to wrap on a small phone screen',
        supplierName: 'Waqar-e-Madina Group (WMT)',
        version: 3,
        nightTo: '2026-11-25',
      },
    ],
    lastPublished: {
      packageId: '64b7f0c2a1b2c3d4e5f6d002',
      packName: 'Ramadan Pack 01',
      supplierName: 'Waqar-e-Madina Group (WMT)',
      version: 5,
      status: 'published',
      publishedAt: '2026-11-16T07:30:00.000Z',
    },
  },
};

async function openDashboard(page: Page, language: 'en' | 'ur') {
  await page.addInitScript((lang) => window.localStorage.setItem('msf.lang', lang), language);
  await page.route('**/api/v1/auth/me', (route) => route.fulfill({ json: admin }));
  await page.route('**/api/v1/admin/dashboard', (route) => route.fulfill({ json: summary }));
  await page.goto('/admin');
}

const cardTitles = (text: typeof en) => [
  text.admin.dashboard.newLeads.title,
  text.admin.dashboard.quotes.title.replace('{{hours}}', '48'),
  text.admin.dashboard.packs.title.replace('{{days}}', '14'),
  text.admin.dashboard.published.title,
];

async function cardLefts(page: Page, text: typeof en): Promise<number[]> {
  const lefts: number[] = [];
  for (const title of cardTitles(text)) {
    const card = page.getByRole('region', { name: title });
    await expect(card).toBeVisible();
    lefts.push(Math.round((await card.boundingBox())?.x ?? -1));
  }
  return lefts;
}

for (const { language, text } of [
  { language: 'en' as const, text: en },
  { language: 'ur' as const, text: ur as typeof en },
]) {
  test(`dashboard fits a 360px phone in one column (${language})`, async ({ page }) => {
    await openDashboard(page, language);
    const lefts = await cardLefts(page, text);
    expect(new Set(lefts).size).toBe(1);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    );
    expect(overflow).toBeLessThanOrEqual(0);
  });
}

test('dashboard uses two columns on a wide screen', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await openDashboard(page, 'en');
  const lefts = await cardLefts(page, en);
  expect(new Set(lefts).size).toBe(2);
});
