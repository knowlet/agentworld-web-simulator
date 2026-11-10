import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
test('search, click, explore, back, reload — all within the simulator', async ({ page }) => {
  const errors: string[] = []; const external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await mkdir('reports', { recursive: true });
  await page.goto('/');
  await expect(page.getByText('MOCK · NO MODEL CALLS')).toBeVisible();
  await page.screenshot({ path: 'reports/mock-home.png', fullPage: true });
  await page.getByRole('textbox', { name: 'Search or URL' }).fill('deep sea exploration');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  const results = page.getByRole('navigation', { name: 'Search results', exact: true });
  await expect(results.getByRole('link')).toHaveCount(6);
  await page.screenshot({ path: 'reports/mock-search.png', fullPage: true });
  await results.getByRole('link').first().click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('deep sea exploration — atlas');
  const firstUrl = page.url();
  await page.screenshot({ path: 'reports/mock-page.png', fullPage: true });
  await page.getByRole('link', { name: /Explore topic 1/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Explore topic 1');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(firstUrl);
  await expect(page.getByText(/Cached observation/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('deep sea exploration — atlas');
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
test('direct URL and API errors are visible, not silently replaced', async ({ page }) => {
  await page.goto('/view?url=' + encodeURIComponent('https://reference.test/ocean'));
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('ocean');
  await page.goto('/view?url=' + encodeURIComponent('javascript:alert(1)'));
  await expect(page.getByRole('alert')).toContainText('Invalid simulated URL');
  await expect(page.getByRole('button', { name: 'Retry', exact: true })).toBeVisible();
});

test('undecodable percent path supports direct navigation, explore, back and reload', async ({ page }) => {
  const errors: string[] = []; const external: string[] = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin !== 'http://127.0.0.1:4173') { external.push(url.href); return route.abort(); }
    return route.continue();
  });
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Search or URL' }).fill('https://fixture.example/%FF');
  await page.getByRole('button', { name: 'Go', exact: true }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('%FF');
  const firstUrl = page.url();
  await page.getByRole('link', { name: /Explore topic 1/ }).click();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Explore topic 1');
  await page.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(page).toHaveURL(firstUrl);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('%FF');
  await expect(page.getByText(/Cached observation/)).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('%FF');
  await expect(page.getByRole('alert')).toHaveCount(0);
  expect(errors).toEqual([]); expect(external).toEqual([]);
});
