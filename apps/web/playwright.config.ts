import { defineConfig, devices } from '@playwright/test';

const PORT = 3100;

/** Shell tests run against the production build (`next build` first). */
export default defineConfig({
  testDir: './e2e',
  outputDir: './test-results',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: 0,
  reporter: [['list']],
  // Baselines are per platform: font rendering differs between Windows and Linux.
  snapshotPathTemplate: '{testDir}/__screenshots__/{platform}/{arg}{ext}',
  expect: { toHaveScreenshot: { maxDiffPixelRatio: 0.01, animations: 'disabled' } },
  use: {
    baseURL: `http://127.0.0.1:${PORT}`,
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
  },
  projects: [
    { name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
  ],
  webServer: {
    command: `pnpm exec next start --port ${PORT} --hostname 127.0.0.1`,
    url: `http://127.0.0.1:${PORT}/en`,
    reuseExistingServer: false,
    timeout: 60_000,
    // Point the status table at closed ports so the page renders the same with or without a backend.
    env: {
      QOS_API_URL: 'http://127.0.0.1:9',
      QOS_WORKER_URL: 'http://127.0.0.1:9',
      QOS_CONTROLLER_URL: 'http://127.0.0.1:9',
      NEXT_TELEMETRY_DISABLED: '1',
    },
  },
});
