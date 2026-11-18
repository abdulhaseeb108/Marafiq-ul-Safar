/**
 * The whole quote flow against a real API and database (docs/04 Phase 6):
 * calculator -> quote request -> staff lead -> quote -> link -> new version ->
 * old link says "replaced" -> customer accepts the new one.
 * Run with: npm run e2e:flow (see playwright.config.ts).
 */
import { expect, test, type Browser, type Page } from '@playwright/test';
import { CUSTOMER_QUOTE_STATUS_WORDING } from '@marafiq/shared';

const SALES = { email: 'e2e-sales@example.com', password: 'e2e-sales-password-1' };

/** The seed moves Ramadan Pack 01 to start 20 days from today (Pakistan time). */
const todayPk = () => new Date(Date.now() + 5 * 3_600_000).toISOString().slice(0, 10);
const addDays = (date: string, days: number) => {
  const at = new Date(`${date}T00:00:00Z`);
  at.setUTCDate(at.getUTCDate() + days);
  return at.toISOString().slice(0, 10);
};
const ARRIVAL = addDays(todayPk(), 22);

async function pickHotel(page: Page, label: string, name: string) {
  const select = page.getByLabel(label);
  const value = await select.locator('option', { hasText: name }).first().getAttribute('value');
  await select.selectOption(value as string);
}

async function staffPage(browser: Browser): Promise<Page> {
  const page = await (await browser.newContext()).newPage();
  await page.goto('/admin/login');
  await page.getByLabel('Email').fill(SALES.email);
  await page.getByLabel('Password').fill(SALES.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('link', { name: 'Leads' })).toBeVisible();
  return page;
}

test('inquiry to accepted quote, with a replaced version', async ({ page: customer, browser }) => {
  // 1. Customer prices a trip (T1 with own flights) and asks for a quote.
  await customer.goto('/umrah');
  await customer.getByLabel('Departure city').selectOption({ label: 'Other city' });
  await customer.getByLabel('Arrival date in Saudi Arabia').fill(ARRIVAL);
  await customer.getByLabel('Nights in Makkah').fill('3');
  await customer.getByLabel('Nights in Madinah').fill('2');
  await customer.getByLabel('Adults', { exact: true }).fill('4');
  await customer.getByLabel('Room type').selectOption('quad');
  await customer.getByLabel('People in this room').fill('4');
  await pickHotel(customer, 'Hotel in Makkah', 'Qila Ajiyad');
  await pickHotel(customer, 'Hotel in Madinah', 'Waqar Salmiya');
  await customer.getByRole('radio', { name: 'I will arrange flights' }).check();
  await customer.getByRole('button', { name: 'See my estimate' }).click();

  const estimate = customer.locator('section', {
    has: customer.getByRole('heading', { name: 'Your estimate' }),
  });
  await expect(estimate.getByText('SAR 3,232')).toBeVisible();
  await expect(estimate.getByText('PKR 242,400')).toBeVisible();
  await estimate.getByRole('button', { name: 'Request a quote' }).click();

  await customer.getByLabel('Your name').fill('Aisha Khan');
  await customer.getByLabel('Mobile number (WhatsApp preferred)').fill('0300 1234567');
  await customer.getByRole('checkbox').check();
  await customer.getByRole('button', { name: 'Send my request' }).click();
  await expect(
    customer.getByRole('heading', { name: 'Thank you, we have your request' }),
  ).toBeVisible();
  const reference = (await customer.getByText(/^MSF-\d{4}-\d{6}$/).textContent())?.trim() as string;

  // 2. Staff find the lead, build the quote from the calculation and send it.
  const staff = await staffPage(browser);
  await staff.getByRole('link', { name: 'Leads' }).click();
  await staff.getByRole('link', { name: reference }).click();
  await expect(staff.getByRole('heading', { name: `${reference} · New` })).toBeVisible();
  await staff.getByRole('button', { name: 'Create quote' }).click();
  await expect(
    staff.getByRole('heading', { name: new RegExp(`${reference} · quote version 1`) }),
  ).toBeVisible();
  await expect(staff.getByText('PKR 242,400 · SAR 3,232')).toBeVisible();
  await staff.getByRole('button', { name: 'Send to customer' }).click();
  const firstLink = await staff.getByLabel('Private link').inputValue();
  expect(firstLink).toMatch(/\/q\/[A-Za-z0-9_-]{43}$/);

  // 3. The customer opens the link.
  await customer.goto(firstLink);
  await expect(customer.getByRole('status')).toHaveText(CUSTOMER_QUOTE_STATUS_WORDING.en.sent);
  await expect(customer.getByText('PKR 242,400')).toBeVisible();

  // 4. Staff change the price in a new version and send it.
  await staff.getByRole('button', { name: 'Make a new version' }).click();
  await expect(staff.getByRole('heading', { name: /quote version 2 · Draft/ })).toBeVisible();
  const unit = staff.getByLabel('Unit price').first();
  await unit.fill('55');
  await staff.getByRole('button', { name: 'Save draft' }).click();
  await expect(staff.getByText('PKR 246,900 · SAR 3,292')).toBeVisible();
  await staff.getByRole('button', { name: 'Send to customer' }).click();
  const secondLink = await staff.getByLabel('Private link').inputValue();
  expect(secondLink).not.toBe(firstLink);

  // 5. The old link now says "replaced" and leads to the new version, which the customer accepts.
  await customer.goto(firstLink);
  await expect(customer.getByRole('status')).toHaveText(CUSTOMER_QUOTE_STATUS_WORDING.en.replaced);
  await expect(customer.getByRole('button', { name: 'Accept quote' })).toHaveCount(0);
  await customer.getByRole('link', { name: 'View the new version' }).click();
  await expect(customer.getByText(/version 2/)).toBeVisible();
  await expect(customer.getByText('PKR 246,900')).toBeVisible();
  await customer.getByRole('button', { name: 'Accept quote' }).click();
  await customer.getByRole('button', { name: 'Yes, accept this quote' }).click();
  await expect(customer.getByRole('status')).toHaveText(CUSTOMER_QUOTE_STATUS_WORDING.en.accepted);
  await expect(customer.locator('body')).not.toContainText(/\bbooked\b/i);

  // 6. Staff see the lead accepted.
  await staff.getByRole('link', { name: `← Lead ${reference}` }).click();
  await expect(
    staff.getByRole('heading', { name: `${reference} · Accepted (request)` }),
  ).toBeVisible();
});

test('a made-up quote link opens nothing', async ({ page }) => {
  const guess = Buffer.from(Array.from({ length: 32 }, (_, i) => (i * 37) % 256)).toString(
    'base64url',
  );
  await page.goto(`/q/${guess}`);
  await expect(page.getByRole('heading', { name: 'This link is not valid' })).toBeVisible();
});
