/**
 * Calculator -> result on a 360px phone, in English and in Urdu (docs/04 Phase 5).
 * The API is mocked with the T1 example from docs/03 section 7.
 */
import { expect, test, type Page } from '@playwright/test';
import en from '../src/locales/en.json' with { type: 'json' };
import ur from '../src/locales/ur.json' with { type: 'json' };
import { ARRIVAL, MAKKAH, MADINAH, config, hotels, sampleQuote, t1Result } from './fixtures';

async function mockApi(page: Page) {
  await page.route('**/api/v1/public/config', (route) => route.fulfill({ json: config }));
  await page.route('**/api/v1/public/hotels', (route) =>
    route.fulfill({ json: { items: hotels } }),
  );
  await page.route('**/api/v1/public/calculate', (route) => route.fulfill({ json: t1Result() }));
  await page.route('**/api/v1/public/quotes/**', (route) => route.fulfill({ json: sampleQuote }));
}

async function startIn(page: Page, language: 'en' | 'ur') {
  await page.addInitScript((lang) => window.localStorage.setItem('msf.lang', lang), language);
  await mockApi(page);
}

async function noSidewaysScroll(page: Page) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(0);
}

const LANGUAGES = [
  { language: 'en' as const, text: en, dir: 'ltr' },
  { language: 'ur' as const, text: ur, dir: 'rtl' },
];

for (const { language, text, dir } of LANGUAGES) {
  test(`calculator to result on a 360px phone (${language})`, async ({ page }) => {
    await startIn(page, language);
    await page.goto('/umrah');
    await expect(page.locator('html')).toHaveAttribute('dir', dir);
    await expect(page.getByRole('heading', { level: 1, name: text.calc.title })).toBeVisible();
    await noSidewaysScroll(page);

    await page.getByLabel(text.calc.departureCity).selectOption('Islamabad');
    await page.getByLabel(text.calc.arrivalDate).fill(ARRIVAL);
    await page.getByLabel(text.calc.nightsMakkah).fill('3');
    await page.getByLabel(text.calc.nightsMadinah).fill('2');
    await page.getByLabel(text.calc.adults, { exact: true }).fill('4');
    await page.getByLabel(text.calc.roomType).selectOption('quad');
    await page.getByLabel(text.calc.inRoom).fill('4');
    await page
      .getByLabel(text.calc.hotelIn.replace('{{city}}', text.calc.city.makkah))
      .selectOption(MAKKAH);
    await page
      .getByLabel(text.calc.hotelIn.replace('{{city}}', text.calc.city.madinah))
      .selectOption(MADINAH);
    await page.getByRole('button', { name: text.calc.calculate }).click();

    const heading = page.getByRole('heading', { name: text.calc.resultTitle });
    await expect(heading).toBeFocused();
    const result = page.locator('section', { has: heading });
    await expect(result.getByText(text.calc.partialLabel)).toBeVisible();
    await expect(result.getByText('PKR 242,400')).toBeVisible();
    await expect(result.getByText('SAR 3,232')).toBeVisible();
    await expect(result.getByText(text.calc.missingTitle)).toBeVisible();
    await expect(result.getByRole('button', { name: text.site.requestQuote })).toBeVisible();
    await noSidewaysScroll(page);

    await page.screenshot({ path: `test-results/calculator-${language}.png`, fullPage: true });
  });
}

test('every public page fits a 360px screen in Urdu', async ({ page }) => {
  await startIn(page, 'ur');
  for (const path of [
    '/',
    '/umrah',
    '/hotels',
    '/flights',
    '/visa',
    '/transport',
    '/faq',
    '/contact',
    '/policies/privacy',
    '/request-quote?topic=umrah',
    `/q/${'A'.repeat(43)}`,
  ]) {
    await page.goto(path);
    await expect(page.locator('h1')).toBeVisible();
    await noSidewaysScroll(page);
  }
});

test('keyboard: skip link, menu and calculator can be used without a mouse', async ({ page }) => {
  await startIn(page, 'en');
  await page.goto('/');
  await page.keyboard.press('Tab');
  const skip = page.getByRole('link', { name: en.site.skip });
  await expect(skip).toBeFocused();
  await expect(skip).toBeVisible();
  await page.keyboard.press('Enter');
  await expect(page.locator('#main')).toBeFocused();

  // Open the phone menu with the keyboard and follow a link.
  const menu = page.getByRole('button', { name: en.site.menu });
  await menu.focus();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Tab');
  await expect(
    page
      .getByRole('navigation', { name: en.site.mainNav })
      .getByRole('link', { name: en.site.nav.umrah, exact: true }),
  ).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { level: 1, name: en.calc.title })).toBeVisible();

  // Submitting an empty form moves focus to the list of problems.
  await page.getByRole('button', { name: en.calc.calculate }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('alert')).toBeFocused();
});
