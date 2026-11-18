/**
 * The staff screens are a separate download. If it fails, staff must see what
 * happened and a way to recover, not a blank page.
 */
import { expect, test } from '@playwright/test';
import en from '../src/locales/en.json' with { type: 'json' };

const ADMIN_CHUNK = /\/assets\/AdminRoutes-[^/]+\.js$/;

test('admin: a failed staff-area download shows a message and Reload recovers', async ({
  page,
}) => {
  await page.addInitScript(() => window.localStorage.setItem('msf.lang', 'en'));
  await page.route('**/api/v1/**', (route) =>
    route.fulfill({ status: 401, json: { error: { code: 'unauthenticated', message: 'x' } } }),
  );
  await page.route(ADMIN_CHUNK, (route) => route.abort('failed'));

  await page.goto('/admin');
  const alert = page.getByRole('alert');
  await expect(alert.getByRole('heading', { name: en.admin.loadFailed.title })).toBeVisible();
  await expect(alert).toContainText(en.admin.loadFailed.body);

  // Once the connection is back, Reload brings the staff area up (signed out: login page).
  await page.unroute(ADMIN_CHUNK);
  await alert.getByRole('button', { name: en.admin.loadFailed.reload }).click();
  await expect(page.getByRole('heading', { name: en.admin.login.title })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
});
