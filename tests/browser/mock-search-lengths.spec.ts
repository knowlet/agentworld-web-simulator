import { test, expect } from '@playwright/test';

test('maximum-length Unicode mock search renders, navigates, and reloads', async ({ page }) => {
  const query = '查'.repeat(500);
  const errors: string[] = [];
  const external: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search or URL' }).fill(query);
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(query);
  const results = page.getByRole('navigation', { name: 'Search results', exact: true });
  await expect(results.getByRole('link')).toHaveCount(6);
  await results.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('查'.repeat(170) + '… — atlas');
  await page.reload();
  await expect(page.getByText(/Cached observation/)).toBeVisible();
  expect(errors).toEqual([]);
  expect(external).toEqual([]);
});
