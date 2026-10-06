import { test, expect } from '@playwright/test';
import { seed, settings, mockOpenRouter } from '../fixtures/openrouter';
const prefix = '/agentworld-web-simulator/';

test('native decision picker never offers chat models after catalog refresh', async ({ page, context }) => {
  await seed(context); const calls = await mockOpenRouter(context);
  await page.goto(prefix); await page.getByRole('button', { name: 'OpenRouter settings', exact: true }).click();
  await page.getByRole('button', { name: '載入模型清單', exact: true }).click();
  await expect(page.locator('#aw-models option[value="ordinary/chat-model"]')).toHaveCount(1);
  await expect(page.locator('#setting-decisions option')).toHaveCount(1);
  await expect(page.locator('#setting-decisions')).toHaveValue(settings().decisionsModel);
  expect(calls).toHaveLength(0);
});

test('stale chat model fails before requests and remains repairable', async ({ page, context }) => {
  await seed(context, { decisionsModel: 'ordinary/chat-model' }); const calls = await mockOpenRouter(context);
  await page.goto(prefix + 'search?q=stale');
  await expect(page.getByRole('heading', { name: 'OpenRouter 設定' })).toBeVisible();
  await expect(page.locator('main')).toContainText('native Decisions');
  expect(calls).toHaveLength(0);
  await page.locator('#setting-decisions').selectOption(settings().decisionsModel);
  await page.getByRole('button', { name: '儲存', exact: true }).click();
  await expect(page.locator('.metadata')).toContainText('New observation');
});

test('clear key warns when the old persisted key could not be overwritten', async ({ page, context }) => {
  await seed(context); await mockOpenRouter(context);
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) {
      if (key === 'agentworld.settings.v1' && JSON.parse(value).apiKey === '') throw new DOMException('fixture denial', 'QuotaExceededError');
      return original.call(this, key, value);
    };
  });
  await page.goto(prefix); await page.getByRole('button', { name: 'OpenRouter settings', exact: true }).click();
  await page.getByRole('button', { name: '清除金鑰', exact: true }).click();
  await expect(page.locator('#setting-key')).toHaveValue('');
  await expect(page.locator('.settings-status')).toContainText('仍可能');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('agentworld.settings.v1')!).apiKey)).toBe(settings().apiKey);
});

test('embedded startup never reads credentials or starts provider requests', async ({ page, context }) => {
  await seed(context); const calls = await mockOpenRouter(context);
  await context.addInitScript(() => {
    (window as unknown as { credentialReads: number }).credentialReads = 0;
    const original = Storage.prototype.getItem;
    Storage.prototype.getItem = function (key) {
      if (key === 'agentworld.settings.v1') (window as unknown as { credentialReads: number }).credentialReads++;
      return original.call(this, key);
    };
  });
  await page.goto('/fixture-parent');
  await page.evaluate(path => {
    const frame = document.createElement('iframe');
    frame.setAttribute('sandbox', 'allow-scripts allow-same-origin'); frame.src = path; document.body.append(frame);
  }, prefix + 'search?q=embedded');
  await expect(page.frameLocator('iframe').getByTestId('embedded-blocked')).toBeVisible();
  const frame = page.frames().find(f => f.url().includes('q=embedded'))!;
  expect(await frame.evaluate(() => (window as unknown as { credentialReads: number }).credentialReads)).toBe(0);
  expect(calls).toHaveLength(0);
  await expect(page.frameLocator('iframe').getByRole('link', { name: '在新分頁直接開啟' })).toHaveAttribute('target', '_blank');
});

test('two actual tabs generate one search and agree on the persisted artifact', async ({ page, context }) => {
  await seed(context); const calls = await mockOpenRouter(context); const second = await context.newPage();
  await Promise.all([page.goto(prefix + 'search?q=shared'), second.goto(prefix + 'search?q=shared')]);
  await expect(page.locator('.metadata')).toBeVisible(); await expect(second.locator('.metadata')).toBeVisible();
  expect(calls.filter(c => c.task === 'search')).toHaveLength(1);
  expect(await page.locator('.world-link').first().getAttribute('href')).toBe(await second.locator('.world-link').first().getAttribute('href'));
});

test('native href, Ctrl-click and reload stay inside the Pages subpath', async ({ page, context }) => {
  await seed(context); await mockOpenRouter(context);
  await page.goto(prefix + 'search?q=links'); const link = page.locator('.world-link').first();
  await expect(link).toHaveAttribute('href', new RegExp('^' + prefix + 'view\\?'));
  const href = await link.getAttribute('href');
  const popupPromise = context.waitForEvent('page');
  await link.click({ modifiers: ['Control'] }); const popup = await popupPromise;
  await expect(popup).toHaveURL(new RegExp('^http://127\\.0\\.0\\.1:4174' + prefix + 'view'));
  await expect(popup.locator('.metadata')).toBeVisible();
  await popup.reload(); await expect(popup.locator('.metadata')).toContainText('Cached observation');
  expect(href?.startsWith(prefix)).toBe(true);
});
