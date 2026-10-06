import { test, expect } from '@playwright/test';
import { seed, mockOpenRouter } from '../fixtures/openrouter';

test('server CSP permits forced browser mode without relaxing frame-ancestors', async ({ page, context }) => {
  await seed(context); await mockOpenRouter(context);
  const response = await page.goto('/search?q=forced');
  const csp = response!.headers()['content-security-policy'];
  expect(csp).toContain("connect-src 'self' https://openrouter.ai");
  expect(csp).toContain("frame-ancestors 'none'");
  await expect(page.locator('.metadata')).toBeVisible();
  await expect(page.locator('.mode')).toContainText('BROWSER');
});
