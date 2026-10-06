import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/static-browser', timeout: 30000, workers: 1,
  reporter: [['list'], ['html', { outputFolder: 'reports/static-browser', open: 'never' }]],
  use: { baseURL: 'http://127.0.0.1:4174', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'bun run build && bun scripts/serve-pr1-static.ts',
    url: 'http://127.0.0.1:4174/__ready', timeout: 60000,
    env: { BASE_PATH: '/agentworld-web-simulator/' },
  },
});
