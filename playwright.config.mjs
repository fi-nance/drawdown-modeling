import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './tests/browser',
  testMatch: '**/*.spec.mjs',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 2,
  timeout: 45_000,
  expect: { timeout: 10_000 },
  reporter: 'list',
  use: {
    baseURL: 'http://127.0.0.1:4187',
    timezoneId: 'America/New_York',
    locale: 'en-US',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
    serviceWorkers: 'block'
  },
  projects: [
    { name: 'desktop', use: { ...devices['Desktop Chrome'], viewport: { width: 1440, height: 1000 } } },
    { name: 'mobile', use: { ...devices['Pixel 7'] } }
  ],
  webServer: {
    command: 'node scripts/devServer.mjs 4187',
    url: 'http://127.0.0.1:4187',
    reuseExistingServer: false,
    env: { PORT: '4187' }
  }
});
